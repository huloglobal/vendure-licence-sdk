/**
 * Admin-session check for plugin REST routes (Vendure 3.8+).
 *
 * Since Vendure 3.8.0 (GHSA-5fpx-9m35-w745) every session records the API it
 * was created for (`session.apiType`), and the Admin API refuses a session
 * that was not created on the Admin API. REST routes added by plugins are NOT
 * checked by Vendure: a Shop-API session of a user who is also an
 * administrator still carries that administrator's permissions into a plugin
 * REST route gated by `ctx.userHasPermissions(...)`. Vendure's AuthGuard
 * documents that plugin authors must check `ctx.session.apiType` themselves.
 *
 * `isAdminApiSession(ctx)` applies the same rule as Vendure's
 * `AuthGuard.sessionIsValidForApi(session, 'admin')`:
 *
 *   - Vendure < 3.8 has no `apiType` on sessions: always `true` (unchanged
 *     behaviour on 3.5 to 3.7).
 *   - No session, or an anonymous session (no user): `true`. Such a session
 *     carries no permissions, so the caller's permission check refuses it.
 *   - An API-key session issued before 3.8 (no `apiType`): `true`, as in core.
 *   - Otherwise only `apiType === 'admin'` passes. A session created before
 *     the upgrade (no `apiType`) is refused, as the Admin API refuses it.
 *
 * Use it next to the permission check of every admin REST route:
 *
 *   if (!isAdminApiSession(ctx) || !ctx.userHasPermissions([Permission.ReadOrder])) → 403
 */

/** Vendure's `API_KEY_AUTH_STRATEGY_NAME` (core 3.6+). */
const API_KEY_STRATEGY = 'apikey';

let sessionsHaveApiType: boolean | undefined;

/** Whether the running `@vendure/core` records `apiType` on sessions (3.8.0+). */
export function vendureSessionsHaveApiType(): boolean {
    if (sessionsHaveApiType === undefined) {
        let version = '';
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            version = require('@vendure/core/package.json').version;
        } catch {
            version = '';
        }
        sessionsHaveApiType = vendureVersionHasSessionApiType(version);
    }
    return sessionsHaveApiType;
}

/** `true` for `3.8.0` and later (pre-releases of 3.8 included). Unparseable → `true` (fail closed). */
export function vendureVersionHasSessionApiType(version: string): boolean {
    const m = /^(\d+)\.(\d+)\./.exec(String(version || ''));
    if (!m) return true;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 3 || (major === 3 && minor >= 8);
}

/** Test hook: force the version answer (`undefined` re-detects). */
export function setVendureSessionsHaveApiTypeForTests(value: boolean | undefined): void {
    sessionsHaveApiType = value;
}

interface SessionLike {
    user?: unknown;
    apiType?: string | null;
    authenticationStrategy?: string | null;
}

/**
 * `false` when the request's session was created on another API than the
 * Admin API (Vendure 3.8+). See the module comment for the exact rule.
 */
export function isAdminApiSession(ctx: { session?: unknown } | null | undefined): boolean {
    if (!vendureSessionsHaveApiType()) return true;
    const session = (ctx?.session ?? undefined) as SessionLike | undefined;
    if (!session || !session.user) return true;
    if (session.apiType == null && session.authenticationStrategy === API_KEY_STRATEGY) return true;
    return session.apiType === 'admin';
}
