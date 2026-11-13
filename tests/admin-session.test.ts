import { afterEach, describe, expect, it } from 'vitest';
import {
    isAdminApiSession,
    setVendureSessionsHaveApiTypeForTests,
    vendureSessionsHaveApiType,
    vendureVersionHasSessionApiType,
} from '../src/admin-session';

const user = { id: 1, identifier: 'admin', verified: true, channelPermissions: [] };

describe('isAdminApiSession', () => {
    afterEach(() => setVendureSessionsHaveApiTypeForTests(undefined));

    it('detects the 3.8 session apiType from the version', () => {
        expect(vendureVersionHasSessionApiType('3.5.0')).toBe(false);
        expect(vendureVersionHasSessionApiType('3.7.4')).toBe(false);
        expect(vendureVersionHasSessionApiType('3.8.0')).toBe(true);
        expect(vendureVersionHasSessionApiType('3.8.0-minor-202607020307')).toBe(true);
        expect(vendureVersionHasSessionApiType('3.8.2')).toBe(true);
        expect(vendureVersionHasSessionApiType('4.0.0')).toBe(true);
        expect(vendureVersionHasSessionApiType('garbage')).toBe(true);
    });

    it('reads the installed @vendure/core version', () => {
        // The monorepo tests against 3.8.x.
        expect(vendureSessionsHaveApiType()).toBe(true);
    });

    it('on Vendure 3.8+ accepts only Admin API sessions for a user', () => {
        setVendureSessionsHaveApiTypeForTests(true);
        expect(isAdminApiSession({ session: { user, apiType: 'admin' } })).toBe(true);
        expect(isAdminApiSession({ session: { user, apiType: 'shop' } })).toBe(false);
        expect(isAdminApiSession({ session: { user, apiType: 'custom' } })).toBe(false);
        // Created before the upgrade: refused, as the Admin API refuses it.
        expect(isAdminApiSession({ session: { user } })).toBe(false);
        expect(isAdminApiSession({ session: { user, apiType: null } })).toBe(false);
    });

    it('keeps pre-3.8 API-key sessions working, as core does', () => {
        setVendureSessionsHaveApiTypeForTests(true);
        expect(isAdminApiSession({ session: { user, authenticationStrategy: 'apikey' } })).toBe(true);
        expect(isAdminApiSession({ session: { user, authenticationStrategy: 'apikey', apiType: 'shop' } })).toBe(false);
    });

    it('leaves anonymous and missing sessions to the permission check', () => {
        setVendureSessionsHaveApiTypeForTests(true);
        expect(isAdminApiSession({ session: { apiType: 'shop' } })).toBe(true);
        expect(isAdminApiSession({})).toBe(true);
        expect(isAdminApiSession(undefined)).toBe(true);
    });

    it('changes nothing on Vendure 3.5 to 3.7', () => {
        setVendureSessionsHaveApiTypeForTests(false);
        expect(isAdminApiSession({ session: { user } })).toBe(true);
        expect(isAdminApiSession({ session: { user, apiType: 'shop' } })).toBe(true);
    });
});
