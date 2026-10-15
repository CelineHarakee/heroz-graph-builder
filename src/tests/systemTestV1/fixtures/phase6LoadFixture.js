// Test-only fixture adapted from phase4D7ProductClosedLoop. Implements only the
// Mongo operations used here; optimistic document conflicts are a controlled
// model, not a substitute for live Mongo transaction/driver verification.
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const { ObjectId } = require('mongodb');
const RealDate = Date;
const instant = Date.parse('2026-10-11T10:00:00Z');
class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
    static [Symbol.hasInstance](value) { return value instanceof RealDate; }
}
// An event-loop yield creates overlapping I/O without sleeps or clock assertions.
const tick = () => new Promise(resolve => setImmediate(resolve));
function copy(v) {
    if (v instanceof RealDate) return new Date(v.getTime());
    if (v instanceof ObjectId) return new ObjectId(v);
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
}
function at(v, key) {
    const parts = key.split('.');
    function walk(value, i) {
        if (i === parts.length) return value;
        if (Array.isArray(value)) return value.map(x => walk(x, i)).flat();
        return walk(value?.[parts[i]], i + 1);
    }
    return walk(v, 0);
}
function matches(record, query) {
    return Object.entries(query).every(([key, expected]) => {
        if (key === '$or') return expected.some(q => matches(record, q));
        const actual = at(record, key);
        if (expected && typeof expected === 'object' && Object.keys(expected).some(k => k.startsWith('$'))) {
            return Object.entries(expected).every(([op, value]) => {
                if (op === '$exists') return (actual !== undefined) === value;
                if (op === '$in') return (Array.isArray(actual) ? actual : [actual]).some(x => value.some(y => isDeepStrictEqual(x, y)));
                if (op === '$gte') return actual >= value;
                if (op === '$lte') return actual <= value;
                if (op === '$lt') return actual < value;
                throw new Error(`Unsupported fixture query ${op}`);
            });
        }
        return Array.isArray(actual) && !Array.isArray(expected)
            ? actual.some(value => isDeepStrictEqual(value, expected)) : isDeepStrictEqual(actual, expected);
    });
}
function fixture() {
    const ids = Object.fromEntries(['parent', 'child', 'vendor', 'category', 'subcategory', 'activity', 'session', 'interest'].map(k => [k, new ObjectId()]));
    const pref = value => ({ value, confidenceScore: 1, source: 'Parent', updatedAt: new Date(instant - 86400000) });
    const data = {
        parents: [{ _id: ids.parent, account: { status: 'Active', preferredLanguage: 'en' } }],
        children: [{ _id: ids.child, parentId: ids.parent, status: 'Active', identity: { dateOfBirth: new Date('2018-01-01'), gender: 'Female' },
            preferences: { socialStyle: pref('Team'), difficulty: pref('Beginner'), experienceStyle: pref('Structured'), commitmentPreference: pref('Weekly') }, parentGoals: [], developmentProfile: [] }],
        vendors: [{ _id: ids.vendor, status: 'Active' }],
        categories: [{ _id: ids.category, isActive: true }],
        subcategories: [{ _id: ids.subcategory, categoryId: ids.category, isActive: true }],
        activities: [{ _id: ids.activity, vendorId: ids.vendor, basicInformation: { nameEn: 'Outdoor Team Starter', status: 'Active' },
            classification: { categoryId: ids.category, subcategoryId: ids.subcategory },
            eligibility: { minimumAge: 6, maximumAge: 12, allowedGenders: ['Female'] },
            experience: { environment: 'Outdoor', socialStyle: 'Team', difficulty: 'Beginner', experienceStyles: ['Structured'], commitmentType: 'Weekly' },
            activityConstraints: { accessibilityFeatures: [], safetyRequirements: [] }, learningOutcomes: [] }],
        sessions: [{ _id: ids.session, activityId: ids.activity, vendorId: ids.vendor,
            schedule: { startDateTime: new Date(instant + 7 * 86400000), endDateTime: new Date(instant + 7 * 86400000 + 3600000), bookingDeadline: new Date(instant + 6 * 86400000), timezone: 'UTC' },
            availability: { status: 'Available', registrationOpen: true }, capacity: { totalCapacity: 10, bookedCapacity: 0, remainingCapacity: 10, minimumParticipants: 1 } }],
        child_interests: [{ _id: ids.interest, childId: ids.child, subcategoryId: ids.subcategory,
            interestScore: { currentScore: 0.7, previousScore: 0.7, lastCalculatedAt: new Date(), lastDecayAt: new Date() },
            confidence: { currentScore: 0.6, evidenceCount: 2, lastCalculatedAt: new Date() },
            evidenceSummary: { interactionBreakdown: [] }, scoreHistory: [],
            metadata: { version: 1, createdAt: new Date(), updatedAt: new Date(), createdBy: 'Fixture', lastSyncedToGraph: null } }],
        interactions: [], question_history: [], parent_decisions: [], ai_jobs: [], graph_sync_queue: [], recommendations: [], bookings: [], goal_library: [], learning_outcomes: []
    };
    const writes = [];
    const stats = { conflicts: 0, duplicateInserts: 0, commits: 0, active: 0, maxActive: 0 };
    const client = { startSession() {
        let original, staged;
        return {
            startTransaction() {
                original = copy(data); staged = copy(data);
                stats.active++; stats.maxActive = Math.max(stats.maxActive, stats.active);
            },
            inTransaction: () => staged !== null && staged !== undefined,
            store(name) { assert.ok(staged); return staged[name]; },
            async commitTransaction() {
                await tick();
                // Test-only optimistic snapshots: validate every changed document
                // before atomically merging any writes. No shared single session.
                const changes = [];
                for (const name of Object.keys(data)) for (const next of staged[name]) {
                    const before = original[name].find(x => isDeepStrictEqual(x._id, next._id));
                    if (isDeepStrictEqual(before, next)) continue;
                    const current = data[name].find(x => isDeepStrictEqual(x._id, next._id));
                    if (!isDeepStrictEqual(before, current)) {
                        stats.conflicts++; throw Object.assign(Error('fixture write conflict'), { code: 112 });
                    }
                    changes.push({ name, next });
                }
                for (const { name, next } of changes) {
                    const index = data[name].findIndex(x => isDeepStrictEqual(x._id, next._id));
                    if (index < 0) data[name].push(copy(next)); else data[name][index] = copy(next);
                }
                staged = null; stats.active--; stats.commits++;
            },
            async abortTransaction() { if (staged) stats.active--; staged = null; },
            async endSession() { assert.equal(staged, null); }
        };
    } };
    const db = {
        client,
        listCollections: (filter = {}) => ({ toArray: async () => Object.keys(data).filter(name => !filter.name || filter.name === name).map(name => ({ name })) }),
        collection(name) {
            assert.ok(Object.hasOwn(data, name), `Unexpected collection ${name}`);
            const store = options => {
                if (options?.session) return options.session.store(name);
                return data[name];
            };
            const trace = op => writes.push({ name, op });
            const rows = (query, options) => {
                const result = store(options).filter(x => matches(x, query));
                if (options?.sort) result.sort((a, b) => {
                    for (const [key, direction] of Object.entries(options.sort)) {
                        if (at(a, key) < at(b, key)) return -direction;
                        if (at(a, key) > at(b, key)) return direction;
                    }
                    return 0;
                });
                return copy(result);
            };
            return {
                async findOne(query, options = {}) { await tick(); return rows(query, options)[0] ?? null; },
                find(query = {}, options = {}) {
                    return { project() { return this; }, async toArray() { await tick(); return rows(query, options); } };
                },
                async insertOne(document, options = {}) {
                    await tick(); trace('insert');
                    const record = copy(document); record._id ??= new ObjectId();
                    if (store(options).some(x => isDeepStrictEqual(x._id, record._id))) {
                        stats.duplicateInserts++;
                        throw Object.assign(Error('duplicate fixture ID'), { code: 11000 });
                    }
                    store(options).push(record); return { acknowledged: true, insertedId: record._id };
                },
                async updateOne(query, update, options = {}) {
                    await tick(); trace('update');
                    const record = store(options).find(x => matches(x, query));
                    if (!record) return { matchedCount: 0, modifiedCount: 0 };
                    if (Array.isArray(update)) {
                        const merge = update[0].$set.preferences.$mergeObjects;
                        record.preferences = { ...(record.preferences ?? {}), ...copy(merge[1].$literal) };
                    } else {
                        assert.deepEqual(Object.keys(update), ['$set']);
                        for (const [key, value] of Object.entries(update.$set)) {
                            const keys = key.split('.');
                            if (keys.includes('$')) {
                                assert.equal(keys[0], 'recommendedItems');
                                keys[keys.indexOf('$')] = String(record.recommendedItems.findIndex(item => isDeepStrictEqual(item.activityId, query['recommendedItems.activityId'])));
                            }
                            const last = keys.pop();
                            const parent = keys.reduce((obj, part) => (obj[part] ??= {}), record);
                            parent[last] = copy(value);
                        }
                    }
                    return { matchedCount: 1, modifiedCount: 1 };
                }
            };
        }
    };
    return { ids, data, db, writes, stats, assertClosed: () => assert.equal(stats.active, 0) };
}

module.exports = { fixture, copy, FixedDate, RealDate, instant, tick };
