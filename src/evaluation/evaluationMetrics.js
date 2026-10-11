// Pure offline metrics. Unknown applicability is null, never negative evidence.
function grade(value) {
    if (value == null) return null;
    if (!Number.isInteger(value) || value < 0 || value > 3) throw new TypeError('Relevance must be an integer from 0 to 3, or unknown');
    return value;
}
function top(items, k) {
    if (!Array.isArray(items)) throw new TypeError('Recommendations must be an array');
    if (!Number.isInteger(k) || k <= 0) throw new TypeError('K must be a positive integer');
    return items.slice(0, k);
}
function relevanceAtK(recommendations, k) {
    const grades = top(recommendations, k).map(item => grade(item.expectedRelevance));
    if (!grades.length || grades.includes(null)) return null;
    return grades.filter(value => value > 0).length / grades.length;
}
function ndcgAtK(recommendations, eligibleGroundTruth, k) {
    const actual = top(recommendations, k).map(item => grade(item.expectedRelevance));
    const ideal = eligibleGroundTruth.map(item => grade(item.expectedRelevance));
    // A missing eligible label could change the ideal ranking; do not discard it.
    if (!actual.length || actual.includes(null) || ideal.includes(null)) return null;
    const dcg = values => values.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0);
    const idcg = dcg([...ideal].sort((a, b) => b - a).slice(0, actual.length));
    return idcg === 0 ? null : dcg(actual) / idcg;
}
function diversityAtK(recommendations, k) {
    const items = top(recommendations, k);
    if (items.length < 2) return null;
    let total = 0, pairs = 0;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.subcategoryId == null || b.subcategoryId == null) return null;
        if (String(a.subcategoryId) === String(b.subcategoryId)) { pairs++; continue; }
        if (a.categoryId == null || b.categoryId == null) return null;
        total += String(a.categoryId) === String(b.categoryId) ? 0.5 : 1;
        pairs++;
    }
    return total / pairs;
}
function explorationRelevanceRate(recommendations) {
    const grades = recommendations.filter(item => item.isExploratory === true)
        .map(item => grade(item.expectedRelevance)).filter(value => value !== null);
    return grades.length ? grades.filter(value => value > 0).length / grades.length : null;
}
function recommendationCoverage(cases) {
    return cases.length ? cases.filter(item => item.recommendations.length > 0).length / cases.length : null;
}
function applicableMean(values) {
    const applicable = values.filter(value => value !== null);
    return applicable.length ? applicable.reduce((sum, value) => sum + value, 0) / applicable.length : null;
}
module.exports = { grade, relevanceAtK, ndcgAtK, diversityAtK, explorationRelevanceRate, recommendationCoverage, applicableMean };
