/**
 * Merchant engagement kit — the pieces every HULO plugin uses to keep
 * the store admin who installed it coming back:
 *
 *   • `PluginPrefs`          one shared `hulo_plugin_prefs` table for small
 *                            per-plugin settings (digest recipient, flags,
 *                            dismissed tips) so nine plugins share one
 *                            mechanism instead of nine ad-hoc tables.
 *   • `composeDigest()`      renders the weekly "what <plugin> did for you"
 *                            report (text + HTML) from a list of stats.
 *   • `WeeklyDigest`         schedules that report once a week per install,
 *                            multi-worker safe (compare-and-swap on the
 *                            `digest.lastSentAt` pref), with a "send now"
 *                            preview for the admin page.
 *   • `smtpTransportFromEnv` the SMTP_* env transport the plugins without
 *                            their own mailer can fall back to.
 *   • `licenceLifecycleNotice` the one sentence the admin banner / digest
 *                            shows when a trial or key is about to end.
 *
 * Everything here is fail-soft: a SQL or SMTP failure is logged and never
 * thrown into the host.
 */
import { Logger } from '@vendure/core';
import type { SqlQueryFn } from './licence-store';
import type { LicenceSummary } from './licence-info';
import type { EvaluationState } from './evaluation';

const loggerCtx = 'LicenceSdk:Engagement';

// ── Shared preferences ─────────────────────────────────────────────────

const PREFS_DDL = `
    CREATE TABLE IF NOT EXISTS hulo_plugin_prefs (
        pluginId VARCHAR(128) NOT NULL,
        prefKey VARCHAR(64) NOT NULL,
        prefValue TEXT NULL,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (pluginId, prefKey)
    )`;

/** Tiny key/value store shared by every HULO plugin (one row per
 *  plugin + key). Values are strings; callers JSON-encode anything else. */
export class PluginPrefs {
    constructor(private readonly query: SqlQueryFn, private readonly pluginId: string) {}

    async ensureTable(): Promise<void> {
        try { await this.query(PREFS_DDL); } catch { /* fail-soft */ }
    }

    async get(key: string): Promise<string | null> {
        try {
            const rows = await this.query(
                'SELECT prefValue FROM hulo_plugin_prefs WHERE pluginId = ? AND prefKey = ?',
                [this.pluginId, key]);
            const v = rows?.[0]?.prefValue;
            return typeof v === 'string' ? v : null;
        } catch { return null; }
    }

    async all(): Promise<Record<string, string>> {
        try {
            const rows = await this.query(
                'SELECT prefKey, prefValue FROM hulo_plugin_prefs WHERE pluginId = ?', [this.pluginId]);
            const out: Record<string, string> = {};
            for (const r of rows || []) if (typeof r?.prefValue === 'string') out[r.prefKey] = r.prefValue;
            return out;
        } catch { return {}; }
    }

    async set(key: string, value: string | null): Promise<void> {
        try {
            if (value === null) {
                await this.query('DELETE FROM hulo_plugin_prefs WHERE pluginId = ? AND prefKey = ?', [this.pluginId, key]);
                return;
            }
            await this.query(
                'INSERT INTO hulo_plugin_prefs (pluginId, prefKey, prefValue, updatedAt) VALUES (?, ?, ?, NOW()) ' +
                'ON DUPLICATE KEY UPDATE prefValue = VALUES(prefValue), updatedAt = NOW()',
                [this.pluginId, key, value],
                { conflictColumns: ['pluginId', 'prefKey'] });
        } catch (e: any) {
            Logger.warn(`[${this.pluginId}] pref ${key} not saved: ${e?.message}`, loggerCtx);
        }
    }

    /** Atomic compare-and-set: only writes when the stored value equals
     *  `expected` (`null` = row absent). Returns true when this caller won.
     *  Used to make "send once a week" safe across worker replicas. */
    async cas(key: string, expected: string | null, value: string): Promise<boolean> {
        try {
            if (expected === null) {
                // needAffected: on Postgres an INSERT without RETURNING comes back
                // as an empty row list, which would read as "another worker won".
                const res = await this.query(
                    'INSERT IGNORE INTO hulo_plugin_prefs (pluginId, prefKey, prefValue, updatedAt) VALUES (?, ?, ?, NOW())',
                    [this.pluginId, key, value],
                    { conflictColumns: ['pluginId', 'prefKey'], needAffected: true });
                return affected(res) > 0;
            }
            const res = await this.query(
                'UPDATE hulo_plugin_prefs SET prefValue = ?, updatedAt = NOW() WHERE pluginId = ? AND prefKey = ? AND prefValue = ?',
                [value, this.pluginId, key, expected]);
            return affected(res) > 0;
        } catch (e: any) {
            Logger.warn(`[${this.pluginId}] pref CAS ${key} failed: ${e?.message}`, loggerCtx);
            return false;
        }
    }

    /** Delete `key` only while it still holds `expected`. */
    async casDelete(key: string, expected: string): Promise<boolean> {
        try {
            const res = await this.query(
                'DELETE FROM hulo_plugin_prefs WHERE pluginId = ? AND prefKey = ? AND prefValue = ?',
                [this.pluginId, key, expected]);
            return affected(res) > 0;
        } catch (e: any) {
            Logger.warn(`[${this.pluginId}] pref CAS delete ${key} failed: ${e?.message}`, loggerCtx);
            return false;
        }
    }
}

function affected(res: any): number {
    if (!res) return 0;
    if (typeof res.affectedRows === 'number') return res.affectedRows;
    if (typeof res.rowCount === 'number') return res.rowCount;
    if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
    return 0;
}

// ── Digest composition ─────────────────────────────────────────────────

export type DigestFormat = 'count' | 'pence' | 'percent' | 'text';

export interface DigestStat {
    /** Stable machine key, e.g. `ordersHeld` — also what the licence server
     *  receives via the heartbeat/evaluation stats providers. */
    key: string;
    /** Merchant-facing label, e.g. "risky orders held for review". */
    label: string;
    /** This period's value (pence for money, 0–100 for percent). */
    value: number;
    /** Previous period's value, when known — rendered as a delta. */
    previous?: number | null;
    format?: DigestFormat;
    /** Optional free-text rendering for `format: 'text'`. */
    text?: string;
    /** ISO 4217 code for `format: 'pence'` (minor units); defaults to GBP. */
    currency?: string;
}

export interface DigestTip {
    /** Short imperative, e.g. "Turn on enforce mode". */
    title: string;
    body: string;
    /** Deep link into the admin (absolute) or docs. */
    url?: string;
    /** Label for the link; defaults to "Open in Admin". */
    linkLabel?: string;
}

export interface DigestInput {
    /** Human plugin name, e.g. "Fraud Prevention". */
    pluginName: string;
    /** Package short id, e.g. `vendure-plugin-fraud-prevention` — builds the buy/docs URLs. */
    shortId: string;
    /** Store name shown in the greeting, when known. */
    storeName?: string | null;
    /** Period covered (inclusive start, exclusive end). */
    periodStart: Date;
    periodEnd: Date;
    stats: DigestStat[];
    /** One to three "next step" nudges; the plugin picks them from its own setup state. */
    tips?: DigestTip[];
    /** Where the admin page lives, e.g. https://shop.example.com/admin/extensions/fraud-prevention */
    adminUrl?: string | null;
    tier: 'paid' | 'trial' | 'free';
    licence?: LicenceSummary | null;
    evalState?: EvaluationState | null;
    /** What the free tier loses — shown to trial/free installs. */
    premiumFeatures?: string[];
    /** Where the admin changes or stops the report (admin page + tab). */
    settingsHint?: string;
    /** Optional absolute https logo URL for the report header (the store's own logo). */
    logoUrl?: string | null;
    /** Optional hex accent colour for the header bar and buttons (default #155dfc). */
    accentColor?: string | null;
}

export interface DigestMail {
    subject: string;
    text: string;
    html: string;
}

const fmtMoney = (pence: number, currency?: string | null) => {
    const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'GBP';
    try {
        return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(pence / 100);
    } catch {
        return `${code} ${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
};
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-GB');
const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const DEFAULT_ACCENT = '#155dfc';
/** Only plain hex colours reach a style attribute. */
function safeColour(c?: string | null): string {
    return typeof c === 'string' && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c.trim()) ? c.trim() : DEFAULT_ACCENT;
}
function button(href: string, label: string, accent: string, primary: boolean): string {
    const style = primary
        ? `display:inline-block;background-color:${accent};color:#ffffff;font-weight:bold;font-size:14px;line-height:20px;text-decoration:none;padding:11px 20px;border-radius:8px;border:1px solid ${accent};`
        : `display:inline-block;background-color:#ffffff;color:${accent};font-weight:bold;font-size:14px;line-height:20px;text-decoration:none;padding:11px 20px;border-radius:8px;border:1px solid ${accent};`;
    return `<a href="${esc(href)}" style="${style}">${esc(label)}</a>`;
}
function box(kind: 'info' | 'warn', inner: string): string {
    const bg = kind === 'warn' ? '#fffbeb' : '#f9fafb';
    const border = kind === 'warn' ? '#fde68a' : '#e5e7eb';
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px 0;"><tr><td style="padding:14px 16px;background-color:${bg};border:1px solid ${border};border-radius:8px;">${inner}</td></tr></table>`;
}

export interface EmailLayoutInput {
    /** `<title>` of the document (escaped here). */
    title: string;
    /** Hidden preview line shown by mail clients (escaped here). */
    preheader?: string;
    /** Bold header text when there is no logo (escaped here). */
    brandName: string;
    /** Absolute https URL of a logo; rendered 140px wide. */
    logoUrl?: string | null;
    /** Hex accent colour for the header bar; defaults to #155dfc. */
    accentColor?: string | null;
    /** Already-escaped HTML for the card body. */
    bodyHtml: string;
    /** Already-escaped HTML for the footer strip (optional). */
    footerHtml?: string;
}

/**
 * The shared HULO plugin e-mail shell: a 600px white card (1px #e5e7eb
 * border, 10px radius) on #f3f4f6, logo or bold name, a 3px accent bar,
 * and an 11px footer strip. Table-based, inline styles only.
 */
export function emailLayout(input: EmailLayoutInput): string {
    const accent = safeColour(input.accentColor);
    const logo = typeof input.logoUrl === 'string' && /^https:\/\//i.test(input.logoUrl.trim())
        ? `<img src="${esc(input.logoUrl.trim())}" alt="${esc(input.brandName)}" width="140" style="display:block;width:140px;max-width:140px;height:auto;border:0;">`
        : `<span style="font-size:18px;line-height:24px;font-weight:bold;color:#111827;">${esc(input.brandName)}</span>`;
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        `<title>${esc(input.title)}</title></head>` +
        '<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial, Helvetica, sans-serif;">' +
        (input.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f4f6;font-size:1px;line-height:1px;">${esc(input.preheader)}</div>` : '') +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:#f3f4f6;"><tr><td align="center" style="padding:24px 12px;">' +
        '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:separate;width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;font-family:Arial, Helvetica, sans-serif;">' +
        `<tr><td style="padding:22px 28px;border-bottom:3px solid ${accent};">${logo}</td></tr>` +
        `<tr><td style="padding:28px 28px 24px 28px;font-size:14px;line-height:22px;color:#374151;">${input.bodyHtml}</td></tr>` +
        (input.footerHtml ? `<tr><td style="padding:14px 28px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 10px 10px;font-size:11px;line-height:16px;color:#6b7280;">${input.footerHtml}</td></tr>` : '') +
        '</table></td></tr></table></body></html>';
}

export function formatStat(s: DigestStat): string {
    switch (s.format) {
        case 'pence': return fmtMoney(s.value, s.currency);
        case 'percent': return `${Math.round(s.value * 10) / 10}%`;
        case 'text': return s.text ?? String(s.value);
        default: return fmtInt(s.value);
    }
}

function deltaText(s: DigestStat): string {
    if (s.previous === undefined || s.previous === null || s.format === 'text') return '';
    const diff = s.value - s.previous;
    if (diff === 0) return 'unchanged';
    if (s.previous === 0) return diff > 0 ? 'new this week' : '';
    const pct = Math.round((diff / Math.abs(s.previous)) * 100);
    return `${diff > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs previous week`;
}

/** The sentence shown when a trial or key is about to end. `null` when
 *  nothing needs saying (healthy paid licence, or no licence at all). */
export function licenceLifecycleNotice(
    licence: LicenceSummary | null | undefined,
    evalState: EvaluationState | null | undefined,
    shortId: string,
    now: Date = new Date(),
): { kind: 'trial-ending' | 'key-expiring' | 'eval-ending' | 'eval-ended'; daysLeft: number; message: string; buyUrl: string } | null {
    const buyUrl = `https://elite.charity/licence/buy/${shortId}`;
    const days = (iso: string) => Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
    if (licence) {
        if (licence.trialEndsAt) {
            const d = days(licence.trialEndsAt);
            if (d >= 0 && d <= 7) {
                return { kind: 'trial-ending', daysLeft: d, buyUrl,
                    message: d === 0
                        ? 'Your free trial ends today — the first subscription charge is due now. Manage or cancel from the billing portal.'
                        : `Your free trial ends in ${d} day${d === 1 ? '' : 's'} (${fmtDate(new Date(licence.trialEndsAt))}). Nothing to do if you want to keep everything running; cancel from the billing portal before then to pay nothing.` };
            }
        }
        if (!licence.master && licence.expiresAt) {
            const d = days(licence.expiresAt);
            if (d >= 0 && d <= 14 && licence.plan !== 'lifetime') {
                return { kind: 'key-expiring', daysLeft: d, buyUrl,
                    message: `Your current licence key is valid until ${fmtDate(new Date(licence.expiresAt))}. Subscriptions renew automatically and install the new key themselves; if the renewal has lapsed, buy again here: ${buyUrl}` };
            }
        }
        return null;
    }
    if (evalState?.active && typeof evalState.daysRemaining === 'number' && evalState.daysRemaining <= 3) {
        const d = evalState.daysRemaining;
        return { kind: 'eval-ending', daysLeft: d, buyUrl,
            message: `${d} day${d === 1 ? '' : 's'} left of the full-featured evaluation. After that the plugin drops to the free tier. Keep everything: ${buyUrl}` };
    }
    if (evalState && !evalState.active && evalState.source === 'server') {
        return { kind: 'eval-ended', daysLeft: 0, buyUrl,
            message: `The evaluation has ended and the plugin is running in the free tier. Your settings are saved; the premium features switch back on the moment a licence is active: ${buyUrl}` };
    }
    return null;
}

/** Render the weekly report. Pure; no I/O. */
export function composeDigest(input: DigestInput): DigestMail {
    const period = `${fmtDate(input.periodStart)} – ${fmtDate(new Date(input.periodEnd.getTime() - 1))}`;
    const headline = input.stats.filter(s => s.value > 0 || s.format === 'text');
    const buyUrl = `https://elite.charity/licence/buy/${input.shortId}`;
    const docsUrl = `https://huloglobal.com/vendure-plugins/${input.shortId}/`;
    const notice = licenceLifecycleNotice(input.licence ?? null, input.evalState ?? null, input.shortId, input.periodEnd);
    const greeting = input.storeName ? `Hi ${input.storeName} team,` : 'Hi,';
    const lead = headline.length
        ? `Here is what ${input.pluginName} did for your store last week (${period}).`
        : `${input.pluginName} was quiet last week (${period}) — nothing to report yet. The tips below get it working for you.`;
    const subject = headline.length
        ? `${input.pluginName}: ${formatStat(headline[0])} ${headline[0].label} last week`
        : `${input.pluginName}: your weekly report`;

    // ── text ──
    const t: string[] = [greeting, '', lead, ''];
    for (const s of headline) {
        const d = deltaText(s);
        t.push(`  • ${formatStat(s)} ${s.label}${d ? ` (${d})` : ''}`);
    }
    if (notice) t.push('', notice.message);
    if (input.tier !== 'paid' && input.premiumFeatures?.length) {
        t.push('', input.tier === 'trial'
            ? 'Included in your evaluation (and lost on the free tier):'
            : 'Switch on with a licence:');
        for (const f of input.premiumFeatures.slice(0, 6)) t.push(`  • ${f}`);
        t.push(`  ${buyUrl}`);
    }
    if (input.tips?.length) {
        t.push('', 'Next steps:');
        for (const tip of input.tips.slice(0, 3)) t.push(`  • ${tip.title} — ${tip.body}${tip.url ? ` ${tip.url}` : ''}`);
    }
    if (input.adminUrl) t.push('', `Open ${input.pluginName}: ${input.adminUrl}`);
    t.push(`Docs: ${docsUrl}`);
    t.push('', 'Kind regards,', 'HULO Global Limited', '',
        input.settingsHint || `Change the recipient or stop this weekly report in Admin → ${input.pluginName} → Weekly report.`);

    // ── html (shared HULO e-mail design: 600px card, accent bar, inline styles only) ──
    const accent = safeColour(input.accentColor);
    const row = (s: DigestStat) => {
        const d = deltaText(s);
        return `<tr><td style="padding:10px 12px 10px 0;border-bottom:1px solid #f3f4f6;font-size:22px;line-height:28px;font-weight:bold;color:#111827;white-space:nowrap;vertical-align:top;">${esc(formatStat(s))}</td>` +
            `<td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:22px;color:#374151;vertical-align:top;">${esc(s.label)}${d ? `<div style="font-size:12px;line-height:18px;color:${d.startsWith('▼') ? '#b45309' : '#047857'};">${esc(d)}</div>` : ''}</td></tr>`;
    };
    const body: string[] = [];
    body.push(`<div style="font-size:12px;line-height:18px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:bold;padding:0 0 4px 0;">${esc(input.pluginName)} &middot; weekly report</div>`);
    body.push(`<h1 style="margin:0 0 10px 0;font-size:22px;line-height:28px;font-weight:bold;color:#111827;">${esc(period)}</h1>`);
    body.push(`<p style="margin:0 0 16px 0;font-size:14px;line-height:22px;color:#374151;">${esc(greeting)} ${esc(lead)}</p>`);
    if (headline.length) body.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px 0;">${headline.map(row).join('')}</table>`);
    if (notice) body.push(box('warn', `<div style="font-size:14px;line-height:22px;color:#78350f;">${esc(notice.message)}</div>`));
    if (input.tier !== 'paid' && input.premiumFeatures?.length) {
        body.push(box('info',
            `<div style="font-size:12px;line-height:18px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:bold;padding:0 0 6px 0;">${input.tier === 'trial' ? 'Included in your evaluation (and lost on the free tier)' : 'Switch on with a licence'}</div>` +
            `<ul style="margin:0 0 12px 0;padding-left:18px;font-size:14px;line-height:22px;color:#374151;">${input.premiumFeatures.slice(0, 6).map(f => `<li>${esc(f)}</li>`).join('')}</ul>` +
            button(buyUrl, input.tier === 'trial' ? 'Keep the full feature set' : 'Get a licence', accent, true)));
    }
    if (input.tips?.length) {
        body.push(`<div style="font-size:12px;line-height:18px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:bold;padding:4px 0 6px 0;">Next steps</div>`);
        body.push(`<ul style="margin:0 0 16px 0;padding-left:18px;font-size:14px;line-height:22px;color:#374151;">`);
        for (const tip of input.tips.slice(0, 3)) {
            body.push(`<li style="margin-bottom:6px;"><strong style="color:#111827;">${esc(tip.title)}</strong> &ndash; ${esc(tip.body)}${tip.url ? ` <a href="${esc(tip.url)}" style="color:${accent};">${esc(tip.linkLabel || 'Open in Admin')}</a>` : ''}</li>`);
        }
        body.push('</ul>');
    }
    const buttons: string[] = [];
    if (input.adminUrl) buttons.push(button(input.adminUrl, `Open ${input.pluginName}`, accent, true));
    buttons.push(button(docsUrl, 'Docs', accent, false));
    body.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:4px 0 0 0;"><tr>${buttons.map(b => `<td style="padding:0 8px 8px 0;">${b}</td>`).join('')}</tr></table>`);
    body.push(`<p style="margin:18px 0 0 0;font-size:14px;line-height:22px;color:#374151;">Kind regards,<br>HULO Global Limited</p>`);
    const h = [emailLayout({
        title: subject,
        preheader: lead,
        brandName: input.storeName || input.pluginName,
        logoUrl: input.logoUrl,
        accentColor: accent,
        bodyHtml: body.join(''),
        footerHtml: esc(input.settingsHint || `Change the recipient or stop this weekly report in Admin → ${input.pluginName} → Weekly report.`) +
            '<br>HULO Global Limited sends this report on behalf of the plugin you installed.',
    })];

    return { subject, text: t.join('\n'), html: h.join('') };
}

// ── SMTP transport from env ────────────────────────────────────────────

export interface MailLike {
    from?: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
    replyTo?: string;
}

export interface MailTransport {
    sendMail(mail: MailLike): Promise<unknown>;
}

let envTransport: MailTransport | null | undefined;

/** Pooled nodemailer transport built from `SMTP_SERVER`/`SMTP_HOST`,
 *  `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`/`SMTP_PASS` and `SMTP_FROM`.
 *  Returns `null` (once-logged) when nodemailer is not installed or the
 *  host is unset — the caller then simply has no digest transport. */
export function smtpTransportFromEnv(): MailTransport | null {
    if (envTransport !== undefined) return envTransport;
    const host = process.env.SMTP_SERVER || process.env.SMTP_HOST;
    if (!host) { envTransport = null; return null; }
    let nodemailer: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        nodemailer = require('nodemailer');
    } catch {
        Logger.info('nodemailer is not installed — weekly reports are off (add nodemailer to the host to enable them)', loggerCtx);
        envTransport = null;
        return null;
    }
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user || 'no-reply@localhost';
    const t = nodemailer.createTransport({
        host, port, secure: port === 465,
        auth: user ? { user, pass } : undefined,
        pool: true, maxConnections: 2, maxMessages: 50,
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
    envTransport = { sendMail: (mail: MailLike) => t.sendMail({ from, ...mail }) };
    return envTransport;
}

/** Test hook. */
export function _resetEnvTransport(): void { envTransport = undefined; }

// ── Weekly scheduler ───────────────────────────────────────────────────

export interface WeeklyDigestOptions {
    /** Package short id, e.g. `vendure-plugin-geo-block` (pref namespace). */
    pluginId: string;
    pluginName: string;
    prefs: PluginPrefs;
    /** Build this week's report input. Receives the period. */
    collect: (periodStart: Date, periodEnd: Date) => Promise<Omit<DigestInput, 'periodStart' | 'periodEnd' | 'pluginName' | 'shortId'>>;
    /** Deliver. Return false (or throw) when nothing could be sent. */
    send: (to: string, mail: DigestMail) => Promise<unknown>;
    /** Fallback recipient when the admin has not set one: the licence's
     *  customer email, the plugin's ops/notify address, the trial lead… */
    defaultRecipient?: () => Promise<string | null> | string | null;
    /** How often the scheduler wakes to check (default 1 h, min 5 min). */
    tickMs?: number;
    /** Send on this ISO weekday (1 = Monday … 7 = Sunday). Default Monday. */
    weekday?: number;
    /** Earliest local hour to send. Default 8. */
    hour?: number;
}

export interface WeeklyDigestSettings {
    enabled: boolean;
    recipient: string | null;
    /** Where the report goes when `recipient` is empty. */
    defaultRecipient: string | null;
    lastSentAt: string | null;
    nextDueAt: string | null;
}

const WEEK_MS = 7 * 86_400_000;

export class WeeklyDigest {
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(private readonly opts: WeeklyDigestOptions) {}

    /** Call on the worker process only (the caller checks ProcessContext). */
    start(): void {
        if (this.timer) return;
        const tick = Math.max(5 * 60_000, this.opts.tickMs ?? 60 * 60_000);
        setTimeout(() => { void this.tick(); }, 90_000);
        this.timer = setInterval(() => { void this.tick(); }, tick);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    async settings(): Promise<WeeklyDigestSettings> {
        const p = await this.opts.prefs.all();
        const last = p['digest.lastSentAt'] || null;
        const enabled = (p['digest.enabled'] ?? 'on') !== 'off';
        return {
            enabled,
            recipient: p['digest.recipient'] || null,
            defaultRecipient: await this.resolveDefault(),
            lastSentAt: last,
            nextDueAt: enabled ? this.nextDue(last ? new Date(last) : null).toISOString() : null,
        };
    }

    async updateSettings(patch: { enabled?: boolean; recipient?: string | null }): Promise<WeeklyDigestSettings> {
        if (typeof patch.enabled === 'boolean') await this.opts.prefs.set('digest.enabled', patch.enabled ? 'on' : 'off');
        if (patch.recipient !== undefined) {
            const r = (patch.recipient || '').trim().toLowerCase();
            if (r && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r)) throw new Error('Enter a valid email address');
            await this.opts.prefs.set('digest.recipient', r || null);
        }
        return this.settings();
    }

    /** Send the current week-to-date report immediately (admin "Send a
     *  test" button). Does not move the weekly clock. */
    async sendNow(to?: string | null): Promise<{ sent: boolean; to: string | null; reason?: string; preview: DigestMail }> {
        const end = new Date();
        const start = new Date(end.getTime() - WEEK_MS);
        const mail = await this.build(start, end);
        const recipient = (to || '').trim() || await this.recipient();
        if (!recipient) return { sent: false, to: null, reason: 'no-recipient', preview: mail };
        try {
            await this.opts.send(recipient, mail);
            return { sent: true, to: recipient, preview: mail };
        } catch (e: any) {
            return { sent: false, to: recipient, reason: e?.message || 'send-failed', preview: mail };
        }
    }

    /** Exposed for tests; normally driven by the timer. Returns true when
     *  this process sent the weekly report. */
    async tick(now: Date = new Date()): Promise<boolean> {
        if (this.running) return false;
        this.running = true;
        try {
            const p = await this.opts.prefs.all();
            if ((p['digest.enabled'] ?? 'on') === 'off') return false;
            const last = p['digest.lastSentAt'] || null;
            if (now.getTime() < this.nextDue(last ? new Date(last) : null, now).getTime()) return false;
            const to = p['digest.recipient'] || await this.resolveDefault();
            if (!to) return false;
            // Win the race against other workers before doing any work.
            if (!(await this.opts.prefs.cas('digest.lastSentAt', last, now.toISOString()))) return false;
            const end = now;
            const start = new Date(end.getTime() - WEEK_MS);
            try {
                const mail = await this.build(start, end);
                await this.opts.send(to, mail);
                Logger.info(`[${this.opts.pluginId}] weekly report sent to ${to}`, loggerCtx);
                return true;
            } catch (e: any) {
                Logger.warn(`[${this.opts.pluginId}] weekly report failed: ${e?.message}`, loggerCtx);
                // Give the clock back so the next tick retries. With no earlier
                // send the row must go (an empty value would never match `null`
                // again and the report would stay stuck until an admin intervened).
                if (last === null) await this.opts.prefs.casDelete('digest.lastSentAt', now.toISOString());
                else await this.opts.prefs.cas('digest.lastSentAt', now.toISOString(), last);
                return false;
            }
        } finally {
            this.running = false;
        }
    }

    private async build(start: Date, end: Date): Promise<DigestMail> {
        const partial = await this.opts.collect(start, end);
        return composeDigest({ ...partial, pluginName: this.opts.pluginName, shortId: this.opts.pluginId, periodStart: start, periodEnd: end });
    }

    private async recipient(): Promise<string | null> {
        return (await this.opts.prefs.get('digest.recipient')) || this.resolveDefault();
    }

    private async resolveDefault(): Promise<string | null> {
        try {
            const v = await this.opts.defaultRecipient?.();
            return v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v.toLowerCase() : null;
        } catch { return null; }
    }

    /** Next send slot: the first `weekday` at ≥ `hour` that is at least
     *  6 days after the last send (so a late send doesn't skip a week). */
    private nextDue(last: Date | null, now: Date = new Date()): Date {
        const weekday = Math.min(7, Math.max(1, this.opts.weekday ?? 1));
        const hour = Math.min(23, Math.max(0, this.opts.hour ?? 8));
        const earliest = last && last.getTime() > 0 ? new Date(last.getTime() + 6 * 86_400_000) : new Date(now.getTime() - 86_400_000 * 7);
        const d = new Date(earliest);
        d.setHours(hour, 0, 0, 0);
        if (d.getTime() < earliest.getTime()) d.setDate(d.getDate() + 1);
        const isoDay = (x: Date) => ((x.getDay() + 6) % 7) + 1;
        while (isoDay(d) !== weekday) d.setDate(d.getDate() + 1);
        return d;
    }
}
