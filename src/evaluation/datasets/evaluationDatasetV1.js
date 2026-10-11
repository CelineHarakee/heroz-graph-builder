// Independent, human-defined benchmark judgments. No scoring or learning imports.
// Templates are private; the factory constructs fresh BSON IDs, Dates and objects.
const { ObjectId } = require('mongodb');
const DATASET_VERSION = 'evaluation-dataset-v1';
const TIME = '2026-10-11T10:00:00.000Z';
const HISTORY_TIME = '2026-10-01T10:00:00.000Z';
const experiences = {
    robotics: ['Indoor', 'Individual', 'Beginner', 'Structured', 'Weekly'],
    football: ['Outdoor', 'Team', 'Beginner', 'Structured', 'Weekly'],
    painting: ['Indoor', 'Individual', 'Beginner', 'Creative', 'OneTime'],
    strategy: ['Indoor', 'Team', 'Intermediate', 'Exploratory', 'OneTime'],
    intermediate: ['Outdoor', 'Team', 'Intermediate', 'Structured', 'Weekly'],
    individual: ['Outdoor', 'Individual', 'Beginner', 'Exploratory', 'OneTime'],
    indoorTeam: ['Indoor', 'Team', 'Beginner', 'Structured', 'Weekly'],
    poor: ['Indoor', 'Individual', 'Advanced', 'Creative', 'OneTime'],
    discovery: ['Indoor', 'Individual', 'Intermediate', 'Exploratory', 'OneTime']
};
// tuple: name, taxonomy key, experience key, relevance, exploratory, reason, outcomes
const candidate = (name, taxonomy, experience, relevance, exploratory, reason, outcomes = []) =>
    ({ name, taxonomy, experience, relevance, exploratory, reason, outcomes });
const outdoor = { environment: 'Outdoor', socialStyle: 'Team', difficulty: 'Beginner' };
const richOutdoor = { ...outdoor, experienceStyle: 'Structured', commitmentPreference: 'Weekly' };
const cases = [
    { id: 'C1', title: 'Minimal Interest Signal', interests: [['robotics', 0.55, 0.2, 1]], candidates: [
        candidate('Robotics Intro', 'robotics', 'robotics', 3, false, 'Directly matches the only known interest.'),
        candidate('Robotics Challenge', 'robotics', 'robotics', 3, false, 'Same known subcategory and strongly supported.'),
        candidate('Strategy Games', 'strategy', 'strategy', 1, true, 'Reasonable adjacent discovery but not directly supported.'),
        candidate('Football', 'football', 'football', 0, false, 'No known evidence supports this activity.'),
        candidate('Painting', 'painting', 'painting', 0, false, 'No known evidence supports this activity.'),
        candidate('Controlled Other Activity', 'other', 'poor', 0, false, 'No known evidence supports this activity.')
    ] },
    { id: 'C2', title: 'Preference-Led Cold Start', preferences: outdoor, candidates: [
        candidate('Beginner Outdoor Football', 'football', 'football', 3, false, 'Matches all three known preferences.'),
        candidate('Beginner Outdoor Team Activity', 'sportsExtra', 'football', 3, false, 'Strong experience fit despite unknown interest.'),
        candidate('Outdoor Team Intermediate Activity', 'sportsExtra', 'intermediate', 2, false, 'Strong partial preference fit.'),
        candidate('Beginner Outdoor Individual Activity', 'stemExtra', 'individual', 2, true, 'Good fit except social style and is a reasonable discovery.'),
        candidate('Indoor Team Activity', 'strategy', 'indoorTeam', 1, false, 'Only partially aligns with known preferences.'),
        candidate('Indoor Individual Advanced Activity', 'painting', 'poor', 0, false, 'Known preferences provide little support.')
    ] },
    { id: 'C3', title: 'Goal-Led Cold Start', goals: ['teamwork'], candidates: [
        candidate('Teamwork Activity A', 'football', 'football', 3, false, 'Explicitly supports Teamwork.', ['teamwork']),
        candidate('Teamwork Activity B', 'sportsExtra', 'football', 3, false, 'Explicitly supports Teamwork.', ['teamwork']),
        candidate('Related Group Teamwork Activity', 'strategy', 'strategy', 2, true, 'Reasonable discovery with explicit Teamwork support.', ['teamwork']),
        candidate('Robotics without Teamwork outcome', 'robotics', 'robotics', 0, false, 'The known active Teamwork goal does not provide support.', ['problem']),
        candidate('Painting without Teamwork outcome', 'painting', 'painting', 0, false, 'The known active Teamwork goal does not provide support.', ['creativity']),
        candidate('Strategy Games without Teamwork outcome', 'strategy', 'strategy', 0, false, 'The known active Teamwork goal does not provide support.', ['problem'])
    ] },
    { id: 'C4', title: 'Near-Empty / True Cold Start', candidates: [
        ['Robotics Intro', 'robotics', 'robotics'], ['Robotics Challenge', 'robotics', 'robotics'],
        ['Controlled STEM Opportunity', 'stemExtra', 'individual'], ['Football', 'football', 'football'],
        ['Painting', 'painting', 'painting'], ['Strategy Games', 'strategy', 'strategy']
    ].map(([name, taxonomy, experience]) => candidate(name, taxonomy, experience, 1, true,
        'Valid eligible opportunity, but there is insufficient child-specific evidence to justify stronger relevance.')) },
    { id: 'P1', title: 'Clear Interest + Preferences', interests: [['football', 0.88, 0.82, 12]], preferences: outdoor, candidates: [
        candidate('Beginner Outdoor Football', 'football', 'football', 3, false, 'Direct Football interest and all known preferences align.'),
        candidate('Second Outdoor Football Activity', 'football', 'football', 3, false, 'Direct Football interest and the preferred experience align.'),
        candidate('Related Sports Activity fitting preferences', 'sportsExtra', 'football', 2, false, 'Related sports category with matching known preferences.'),
        candidate('Strategy Activity fitting some preferences', 'strategy', 'indoorTeam', 1, true, 'Team and Beginner fit make this a reasonable discovery despite unknown interest.'),
        candidate('Indoor Football Activity', 'football', 'indoorTeam', 2, false, 'Direct interest remains relevant despite an environment mismatch.'),
        candidate('Unsupported / mismatched activity', 'painting', 'poor', 0, false, 'No direct interest support and the known experience preferences conflict.')
    ] },
    { id: 'P2', title: 'Interest + Goal + Eligibility Boundary', interests: [['football', 0.8, 0.75, 8]], goals: ['teamwork'], full: 1, candidates: [
        candidate('Football + Teamwork A', 'football', 'football', 3, false, 'Direct Football interest and explicit Teamwork support.', ['teamwork']),
        candidate('Football + Teamwork B', 'football', 'football', 3, false, 'Direct Football interest and Teamwork support remain highly relevant despite a full session.', ['teamwork']),
        candidate('Football only', 'football', 'football', 2, false, 'Direct interest support without support for the active goal.'),
        candidate('Teamwork outcome only', 'strategy', 'strategy', 2, true, 'Explicit Teamwork support offers a relevant discovery outside the known interest.', ['teamwork']),
        candidate('Adjacent Sports', 'sportsExtra', 'football', 1, true, 'Related sports category offers limited adjacent support.'),
        candidate('Unsupported Activity', 'painting', 'painting', 0, false, 'Neither the known interest nor active goal supports this activity.', ['creativity'])
    ] },
    { id: 'P3', title: 'Mixed Legitimate Signals', interests: [['robotics', 0.8, 0.7, 6]], preferences: outdoor, candidates: [
        candidate('Robotics with partial preference fit', 'robotics', 'indoorTeam', 3, false, 'Direct Robotics interest with Team and Beginner fit.'),
        candidate('Outdoor Team Activity', 'sportsExtra', 'football', 3, false, 'Excellent fit to all known preferences provides strong independent support.'),
        candidate('Robotics with weak experience fit', 'robotics', 'poor', 2, false, 'Direct interest remains relevant despite weak experience fit.'),
        candidate('Outdoor Adjacent STEM Activity', 'stemExtra', 'football', 2, true, 'Adjacent STEM activity with compatible experience is a reasonable discovery.'),
        candidate('Partial Preference Activity', 'strategy', 'indoorTeam', 1, true, 'Some known preferences support trying a different activity.'),
        candidate('Unsupported / mismatched activity', 'painting', 'poor', 0, false, 'No interest support and poor fit to known preferences.')
    ] },
    { id: 'P4', title: 'Behavior-Refined Profile', interests: [['painting', 0.8, 0.75, 8]], preferences: { experienceStyle: 'Creative' }, saves: [0, 2], candidates: [
        candidate('Painting + prior Save', 'painting', 'painting', 3, false, 'Painting interest, Creative preference and a prior Save align.'),
        candidate('Painting without Save', 'painting', 'painting', 3, false, 'Painting interest and Creative preference provide strong support without behavior.'),
        candidate('Creative Adjacent Activity + Save', 'artsExtra', 'painting', 2, true, 'Creative preference and prior Save support adjacent arts discovery.'),
        candidate('Creative Activity without interest', 'stemExtra', 'painting', 2, true, 'Creative experience provides support outside the known interest.'),
        candidate('Weakly Related Activity', 'artsExtra', 'robotics', 1, false, 'Related arts category gives limited support despite a different experience style.'),
        candidate('Unsupported Activity', 'football', 'football', 0, false, 'No Painting interest, Creative fit, or positive behavior supports this activity.')
    ] },
    { id: 'R1', title: 'Strongly Aligned Profile', interests: [['football', 0.9, 0.9, 20]], preferences: richOutdoor, goals: ['teamwork'], saves: [0, 1], candidates: [
        candidate('Fully Aligned Football + Teamwork', 'football', 'football', 3, false, 'Direct interest, all preferences, Teamwork and a prior Save align.', ['teamwork']),
        candidate('Second Strongly Aligned Football', 'football', 'football', 3, false, 'Strong direct interest, preferred experience, Teamwork and positive behavior.', ['teamwork']),
        candidate('Related Sports + Teamwork', 'sportsExtra', 'football', 2, false, 'Related sports, matching preferences and explicit Teamwork support.', ['teamwork']),
        candidate('Adjacent Outdoor Team Activity', 'stemExtra', 'football', 2, true, 'Strong experience fit makes adjacent discovery reasonable.'),
        candidate('Weak Partial Fit', 'strategy', 'strategy', 1, true, 'Team participation offers limited preference support for discovery.'),
        candidate('Known Poor Fit', 'painting', 'poor', 0, false, 'Conflicts with known preferences and lacks interest, goal or Save support.', ['creativity'])
    ] },
    { id: 'R2', title: 'Multiple Genuine Interests', interests: [['football', 0.9, 0.9, 20], ['painting', 0.88, 0.88, 18]],
        preferences: { environment: 'Mixed', socialStyle: 'Mixed', difficulty: 'Beginner', experienceStyle: 'Mixed', commitmentPreference: 'Weekly' }, saves: [0, 2], candidates: [
        candidate('Strong Football Activity', 'football', 'football', 3, false, 'Strong Football interest, compatible preferences and positive history.'),
        candidate('Second Football Activity', 'football', 'football', 3, false, 'Strong genuine Football interest with compatible experience.'),
        candidate('Strong Painting Activity', 'painting', 'painting', 3, false, 'Strong Painting interest, flexible preferences and positive history.'),
        candidate('Second Painting Activity', 'painting', 'painting', 3, false, 'Strong genuine Painting interest and compatible style despite a different commitment.'),
        candidate('Adjacent Activity', 'artsExtra', 'painting', 2, true, 'Adjacent arts discovery fits the established Painting interest and flexible preferences.'),
        candidate('Weak Unsupported Activity', 'other', 'poor', 0, false, 'Neither genuine interest supports this activity and its difficulty conflicts.')
    ] },
    { id: 'R3', title: 'Strong Profile + Reasonable Exploration', interests: [['robotics', 0.9, 0.9, 20], ['strategy', 0.8, 0.85, 15]],
        preferences: { environment: 'Indoor', socialStyle: 'Individual', difficulty: 'Intermediate', experienceStyle: 'Exploratory', commitmentPreference: 'OneTime' },
        saves: [0, 1], displayed: [0, 1, 2], candidates: [
        candidate('Strong Known Match A', 'robotics', 'discovery', 3, false, 'Established Robotics interest, compatible rich preferences and a prior Save.'),
        candidate('Strong Known Match B', 'strategy', 'discovery', 3, false, 'Established Strategy Games interest, preferred experience and a prior Save.'),
        candidate('Relevant Known Match', 'robotics', 'robotics', 2, false, 'Known Robotics interest remains relevant despite partial experience fit.'),
        candidate('Adjacent Discovery A', 'stemExtra', 'discovery', 2, true, 'Known-new adjacent STEM opportunity fits the established profile.'),
        candidate('Adjacent Discovery B', 'other', 'strategy', 1, true, 'Known-new adjacent Games & Logic opportunity has limited but legitimate support.'),
        candidate('Random Unsupported Activity', 'football', 'football', 0, false, 'Different does not mean exploratory: known interests and preferences give little support.')
    ] },
    { id: 'R4', title: 'Competing Strong Signals', interests: [['robotics', 0.92, 0.9, 22], ['football', 0.82, 0.85, 16]],
        preferences: richOutdoor, goals: ['teamwork'], saves: [1, 3], candidates: [
        candidate('Activity A', 'robotics', 'robotics', 3, false, 'Strongest direct interest support despite competing experience preferences.'),
        candidate('Activity B', 'sportsExtra', 'football', 3, false, 'Excellent preference fit and prior Save provide strong independent support.'),
        candidate('Activity C', 'football', 'intermediate', 3, false, 'Strong direct Football interest plus explicit Teamwork support.', ['teamwork']),
        candidate('Activity D', 'robotics', 'indoorTeam', 2, false, 'Balanced direct interest, partial preference fit and positive behavior.'),
        candidate('Activity E', 'stemExtra', 'football', 2, true, 'Adjacent STEM discovery combines category familiarity with preferred experience.'),
        candidate('Activity F', 'painting', 'poor', 0, false, 'Weak across known interests, preferences, active goal and behavior.', ['creativity'])
    ] }
];

function createEvaluationDatasetV1() {
    const builtCases = cases.map((spec, caseIndex) => {
        // Disjoint fixed namespaces per case; no wall clock or random ID generation.
        const oid = n => new ObjectId((0x500000 + caseIndex * 1000 + n).toString(16).padStart(24, '0'));
        const timestamp = () => new Date(HISTORY_TIME);
        const categoryKeys = ['stem', 'arts', 'sports', 'games'];
        const categoryNames = ['STEM', 'Arts', 'Sports', 'Games & Logic'];
        const categories = categoryKeys.map((key, i) => ({ _id: oid(10 + i), name: categoryNames[i], isActive: true }));
        const taxonomy = [
            ['robotics', 'Robotics', 'stem'], ['painting', 'Painting', 'arts'], ['football', 'Football', 'sports'], ['strategy', 'Strategy Games', 'games'],
            ['stemExtra', 'Benchmark-controlled STEM subcategory', 'stem'], ['artsExtra', 'Benchmark-controlled Arts subcategory', 'arts'],
            ['sportsExtra', 'Benchmark-controlled Sports subcategory', 'sports'], ['other', 'Benchmark-controlled Games & Logic subcategory', 'games']
        ];
        const subcategories = taxonomy.map(([key, name, category], i) => ({ _id: oid(20 + i), name, categoryId: categories[categoryKeys.indexOf(category)]._id, isActive: true }));
        const sub = key => subcategories[taxonomy.findIndex(row => row[0] === key)];
        const outcomeKeys = ['problem', 'teamwork', 'creativity'];
        const outcomes = ['Problem Solving', 'Teamwork', 'Creativity'].map((name, i) => ({ _id: oid(30 + i), name, outcomeType: i === 1 ? 'Social' : 'Cognitive', isActive: true }));
        const goals = ['Improve Problem Solving', 'Build Teamwork', 'Grow Creativity'].map((name, i) => ({ _id: oid(40 + i), name, isActive: true, relatedOutcomes: [{ outcomeId: outcomes[i]._id }] }));
        const preferences = Object.fromEntries(Object.entries(spec.preferences ?? {}).map(([dimension, value]) => [dimension, { value, confidenceScore: 1, source: 'Parent', updatedAt: timestamp() }]));
        const child = { _id: oid(2), parentId: oid(1), status: 'Active', identity: { dateOfBirth: new Date('2018-01-01T00:00:00.000Z'), gender: 'Female' }, preferences,
            parentGoals: (spec.goals ?? []).map((key, i) => ({ goalId: goals[outcomeKeys.indexOf(key)]._id, priority: i + 1, status: 'Active', selectedBy: 'Parent', selectedAt: timestamp(), targetDate: null })), developmentProfile: [] };
        const fixture = {
            parents: [{ _id: oid(1), account: { status: 'Active', preferredLanguage: 'en' }, hardRequirements: { accessibilityRequirements: [], safetyRequirements: [] },
                recommendationPreferences: { preferredDays: [], excludedActivityIds: [], excludedVendorIds: [] } }],
            children: [child], vendors: [{ _id: oid(3), status: 'Active' }], categories, subcategories, learning_outcomes: outcomes, goal_library: goals,
            activities: [], sessions: [], child_interests: (spec.interests ?? []).map(([key, score, confidence, count], i) => ({
                _id: oid(50 + i), childId: child._id, subcategoryId: sub(key)._id,
                interestScore: { currentScore: score, previousScore: score, lastCalculatedAt: timestamp(), lastDecayAt: timestamp() },
                confidence: { currentScore: confidence, evidenceCount: count, lastCalculatedAt: timestamp() },
                evidenceSummary: { interactionBreakdown: [] }, scoreHistory: [],
                metadata: { version: 1, createdBy: 'EvaluationDatasetV1', createdAt: timestamp(), updatedAt: timestamp(), lastSyncedToGraph: null }
            })), interactions: [], bookings: [], recommendations: [], parent_decisions: [], question_history: [], ai_jobs: [], graph_sync_queue: []
        };
        const annotations = spec.candidates.map((definition, i) => {
            const [environment, socialStyle, difficulty, style, commitmentType] = experiences[definition.experience];
            const classification = sub(definition.taxonomy);
            const activity = { _id: oid(100 + i), vendorId: oid(3), basicInformation: { nameEn: definition.name, status: 'Active' },
                classification: { categoryId: classification.categoryId, subcategoryId: classification._id },
                experience: { environment, socialStyle, difficulty, experienceStyles: [style], commitmentType },
                learningOutcomes: definition.outcomes.map(key => ({ outcomeId: outcomes[outcomeKeys.indexOf(key)]._id })),
                eligibility: { minimumAge: 6, maximumAge: 12, allowedGenders: ['Female'] }, activityConstraints: { accessibilityFeatures: [], safetyRequirements: [] } };
            fixture.activities.push(activity);
            fixture.sessions.push({ _id: oid(200 + i), activityId: activity._id, vendorId: oid(3),
                schedule: { startDateTime: new Date('2026-10-18T10:00:00.000Z'), endDateTime: new Date('2026-10-18T11:00:00.000Z'), bookingDeadline: new Date('2026-10-17T10:00:00.000Z'), timezone: 'UTC' },
                availability: { status: spec.full === i ? 'Full' : 'Available', registrationOpen: true }, capacity: { remainingCapacity: 10, totalCapacity: 12, bookedCapacity: 2, minimumParticipants: 1 } });
            // D1 consumes activity._id and classification. activityId is an explicit
            // annotation reference, not a replacement for the frozen D1 shape.
            return { activityId: String(activity._id), activity, expectedRelevance: definition.relevance, relevanceReason: definition.reason, isExploratory: definition.exploratory };
        });
        for (const [index, candidateIndex] of (spec.saves ?? []).entries()) fixture.interactions.push({ _id: oid(300 + index), actor: { childId: child._id, actorType: 'Child' },
            targetEntity: { entityType: 'Activity', entityId: fixture.activities[candidateIndex]._id }, interactionDetails: { interactionType: 'Save' }, timestamp: timestamp() });
        for (const [index, candidateIndex] of (spec.displayed ?? []).entries()) fixture.recommendations.push({ _id: oid(400 + index), childId: child._id,
            recommendationContext: { requestedAt: timestamp() }, recommendedItems: [{ activityId: fixture.activities[candidateIndex]._id }], response: { wasDisplayed: true, displayedAt: timestamp() } });
        return { caseId: spec.id, title: spec.title, profileState: spec.id[0] === 'C' ? 'COLD_START' : spec.id[0] === 'P' ? 'PARTIAL_KNOWLEDGE' : 'RICH_KNOWLEDGE',
            childId: String(child._id), fixture, candidates: annotations };
    });
    return { name: 'Evaluation Dataset V1', datasetVersion: DATASET_VERSION, evaluatedAt: new Date(TIME), cases: builtCases,
        taxonomyNote: 'Named reference examples reuse repository synthetic seeds; Benchmark-controlled subcategories are not established production vocabulary.' };
}
module.exports = { DATASET_VERSION, createEvaluationDatasetV1 };
