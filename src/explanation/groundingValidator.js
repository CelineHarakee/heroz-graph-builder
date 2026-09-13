const { GENERATION_STATUS } = require("./languageGenerator");

const SUPPORTED_LANGUAGES = Object.freeze(["en", "ar"]);
const MAX_REASON_COUNT = 3;

const ERROR_CODES = Object.freeze({
    MISSING_GENERATED_EXPLANATION: "MISSING_GENERATED_EXPLANATION",
    INVALID_GENERATION_STATUS: "INVALID_GENERATION_STATUS",
    UNSUPPORTED_LANGUAGE: "UNSUPPORTED_LANGUAGE",
    LANGUAGE_MISMATCH: "LANGUAGE_MISMATCH",
    EMPTY_TEXT: "EMPTY_TEXT",
    REASON_TYPES_MISMATCH: "REASON_TYPES_MISMATCH",
    TOO_MANY_REASONS: "TOO_MANY_REASONS",
    DUPLICATE_REASON_TYPE: "DUPLICATE_REASON_TYPE",
    NEUTRAL_FALLBACK_REQUIRED: "NEUTRAL_FALLBACK_REQUIRED",
    LANGUAGE_SCRIPT_MISMATCH: "LANGUAGE_SCRIPT_MISMATCH",
    SCORE_LEAKAGE: "SCORE_LEAKAGE",
    UNSUPPORTED_INTEREST_CLAIM: "UNSUPPORTED_INTEREST_CLAIM",
    UNSUPPORTED_PREFERENCE_CLAIM: "UNSUPPORTED_PREFERENCE_CLAIM",
    UNSUPPORTED_GOAL_CLAIM: "UNSUPPORTED_GOAL_CLAIM",
    UNSUPPORTED_EXPLORATION_CLAIM: "UNSUPPORTED_EXPLORATION_CLAIM",
    UNSUPPORTED_BEHAVIOR_CLAIM: "UNSUPPORTED_BEHAVIOR_CLAIM",
    UNSUPPORTED_SESSION_CLAIM: "UNSUPPORTED_SESSION_CLAIM",
    UNSUPPORTED_PRACTICAL_CLAIM: "UNSUPPORTED_PRACTICAL_CLAIM"
});

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function addError(errors, code, message) {
    errors.push({ code, message });
}

function arraysEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
        return false;
    }

    if (left.length !== right.length) {
        return false;
    }

    return left.every((item, index) => item === right[index]);
}

function hasDuplicates(values) {
    return new Set(values).size !== values.length;
}

function hasArabic(text) {
    return /[\u0600-\u06FF]/.test(text);
}

function hasEnglishProse(text) {
    return /\b(the|this|that|your|child|activity|recommend|recommended|supports|matches|preference|interest|goal|session|available|because|reason)\b/i
        .test(text);
}

function containsAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}

function validateTextLanguage(text, language, errors) {
    if (language === "en" && hasArabic(text)) {
        addError(
            errors,
            ERROR_CODES.LANGUAGE_SCRIPT_MISMATCH,
            "English explanation contains Arabic prose"
        );
    }

    if (language === "ar" && hasEnglishProse(text)) {
        addError(
            errors,
            ERROR_CODES.LANGUAGE_SCRIPT_MISMATCH,
            "Arabic explanation contains English prose"
        );
    }
}

function validateScoreLeakage(text, errors) {
    if (
        containsAny(text, [
            /\b\d+(?:\.\d+)?%/,
            /\bscore(?:\s+of)?\s+\d+(?:\.\d+)?\b/i,
            /\b\d+(?:\.\d+)?\s+score\b/i,
            /\bweighted\s+at\b/i,
            /\bweight\b/i,
            /\bnormalized\b/i,
            /\bcontribution\b/i
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.SCORE_LEAKAGE,
            "Explanation exposes scoring internals"
        );
    }
}

function validateUnsupportedReasonClaims(plan, text, errors) {
    const reasonTypes = new Set(plan.reasonTypes ?? []);

    if (
        !reasonTypes.has("interest") &&
        containsAny(text, [
            /\binterest(?:ed)?\b/i,
            /اهتمام|مهتم/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_INTEREST_CLAIM,
            "Explanation introduces Interest without selected Interest reason"
        );
    }

    if (
        !reasonTypes.has("preference") &&
        containsAny(text, [
            /\bpreference\b/i,
            /تفضيل|يفضل|يناسب/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_PREFERENCE_CLAIM,
            "Explanation introduces Preference without selected Preference reason"
        );
    }

    if (
        !reasonTypes.has("goal") &&
        containsAny(text, [
            /\bgoal\b/i,
            /\bdevelop(?:s|ment)?\b/i,
            /هدف|تطور|تنمية/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_GOAL_CLAIM,
            "Explanation introduces Goal without selected Goal reason"
        );
    }

    if (
        !reasonTypes.has("exploration") &&
        containsAny(text, [
            /\bnew activity\b/i,
            /\bexplor(?:e|ation)\b/i,
            /استكشاف|جديد/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_EXPLORATION_CLAIM,
            "Explanation introduces Exploration without selected Exploration reason"
        );
    }

    if (
        !reasonTypes.has("behavior") &&
        containsAny(text, [
            /\bprevious(?:ly)?\s+(?:engagement|saved|booked|attended|completed|rated|viewed|clicked)\b/i,
            /تفاعل سابق|سبق أن|حفظ|حجز|حضر|أكمل|قيّم|شاهد|فتح/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_BEHAVIOR_CLAIM,
            "Explanation introduces Behavior without selected Behavior reason"
        );
    }

    if (
        !reasonTypes.has("session") &&
        containsAny(text, [
            /\bpreferred day\b/i,
            /يوم مفضل|يوما مفضلا/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_SESSION_CLAIM,
            "Explanation introduces Session Suitability without selected Session reason"
        );
    }
}

function validateSelectedReasonSafety(plan, text, errors) {
    for (const reason of plan.reasons ?? []) {
        if (
            reason.type === "preference" &&
            reason.sourceEvidence?.baseMatch !== 1 &&
            containsAny(text, [
                /\bexact match\b/i,
                /\bperfect match\b/i
            ])
        ) {
            addError(
                errors,
                ERROR_CODES.UNSUPPORTED_PREFERENCE_CLAIM,
                "Partial Preference support is described as exact"
            );
        }

        if (
            reason.type === "goal" &&
            containsAny(text, [
                /\bguarantee(?:s|d)?\b/i,
                /\bwill develop\b/i,
                /\bmaster(?:y|s)?\b/i,
                /\bdiagnos(?:e|is)\b/i,
                /\bproves? (?:intelligence|ability)\b/i,
                /يضمن|سوف يطور|إتقان|تشخيص|يثبت/
            ])
        ) {
            addError(
                errors,
                ERROR_CODES.UNSUPPORTED_GOAL_CLAIM,
                "Goal wording exceeds approved support semantics"
            );
        }

        if (
            reason.type === "exploration" &&
            containsAny(text, [
                /\bpopular\b/i,
                /\btrending\b/i,
                /\bhigh quality\b/i,
                /\bbest\b/i,
                /\bnew on the market\b/i,
                /شائع|رائج|عالي الجودة|الأفضل|جديد في السوق/
            ])
        ) {
            addError(
                errors,
                ERROR_CODES.UNSUPPORTED_EXPLORATION_CLAIM,
                "Exploration wording introduces unsupported market/quality claim"
            );
        }

        if (
            reason.type === "behavior" &&
            reason.actorAttribution === "parent" &&
            containsAny(text, [
                /\byour child previously\b/i,
                /طفلك سبق/
            ])
        ) {
            addError(
                errors,
                ERROR_CODES.UNSUPPORTED_BEHAVIOR_CLAIM,
                "Parent-attributed Behavior is described as Child behavior"
            );
        }

        if (
            reason.type === "behavior" &&
            reason.actorAttribution === "neutral" &&
            containsAny(text, [
                /\byour child previously\b/i,
                /\bparent engagement\b/i,
                /طفلك سبق|ولي الأمر/
            ])
        ) {
            addError(
                errors,
                ERROR_CODES.UNSUPPORTED_BEHAVIOR_CLAIM,
                "Neutral Behavior invents an actor"
            );
        }

        if (
            reason.type === "session" &&
            containsAny(text, [
                /\bpreferred time\b/i,
                /\btime of day\b/i,
                /\bmorning\b/i,
                /\bevening\b/i,
                /وقت مفضل|وقت اليوم|صباح|مساء/
            ])
        ) {
            addError(
                errors,
                ERROR_CODES.UNSUPPORTED_SESSION_CLAIM,
                "Session wording introduces unsupported preferred time"
            );
        }
    }
}

function validatePracticalSupport(plan, text, errors) {
    if (
        plan.practicalSupport?.hasEligibleSession !== true &&
        containsAny(text, [
            /\beligible session is (?:also )?currently available\b/i,
            /\bcurrently available session\b/i,
            /حصة مؤهلة متاحة حاليا/
        ])
    ) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_PRACTICAL_CLAIM,
            "Explanation claims eligible Session availability when practical support is false"
        );
    }
}

function validateExplanationGrounding(
    explanationPlan,
    generatedExplanation,
    expectedLanguage
) {
    const errors = [];

    if (!isPlainObject(explanationPlan)) {
        addError(errors, "MISSING_EXPLANATION_PLAN", "Explanation Plan is required");
    }

    if (!isPlainObject(generatedExplanation)) {
        addError(
            errors,
            ERROR_CODES.MISSING_GENERATED_EXPLANATION,
            "Generated explanation is required"
        );

        return {
            valid: false,
            errors
        };
    }

    const planReasonTypes = explanationPlan?.reasonTypes ?? [];

    if (planReasonTypes.length > MAX_REASON_COUNT) {
        addError(
            errors,
            ERROR_CODES.TOO_MANY_REASONS,
            "Explanation Plan exceeds maximum reason count"
        );
    }

    if (hasDuplicates(planReasonTypes)) {
        addError(
            errors,
            ERROR_CODES.DUPLICATE_REASON_TYPE,
            "Explanation Plan contains duplicate reason types"
        );
    }

    if (explanationPlan?.neutralFallbackRequired === true) {
        addError(
            errors,
            ERROR_CODES.NEUTRAL_FALLBACK_REQUIRED,
            "Normal generated explanation cannot be accepted for neutral fallback plan"
        );
    }

    if (generatedExplanation.status !== GENERATION_STATUS.GENERATED) {
        addError(
            errors,
            ERROR_CODES.INVALID_GENERATION_STATUS,
            "Generated explanation status is not generated"
        );
    }

    const language = generatedExplanation.language;

    if (!SUPPORTED_LANGUAGES.includes(language)) {
        addError(
            errors,
            ERROR_CODES.UNSUPPORTED_LANGUAGE,
            "Generated explanation language is unsupported"
        );
    }

    if (
        expectedLanguage !== undefined &&
        language !== expectedLanguage
    ) {
        addError(
            errors,
            ERROR_CODES.LANGUAGE_MISMATCH,
            "Generated explanation language does not match stored language"
        );
    }

    if (
        typeof generatedExplanation.text !== "string" ||
        generatedExplanation.text.trim().length === 0
    ) {
        addError(
            errors,
            ERROR_CODES.EMPTY_TEXT,
            "Generated explanation text is empty"
        );
    }

    if (
        !arraysEqual(generatedExplanation.reasonTypes, planReasonTypes) ||
        hasDuplicates(generatedExplanation.reasonTypes ?? [])
    ) {
        addError(
            errors,
            ERROR_CODES.REASON_TYPES_MISMATCH,
            "Generated explanation reasonTypes do not match the approved plan"
        );
    }

    if (typeof generatedExplanation.text === "string") {
        validateTextLanguage(generatedExplanation.text, language, errors);
        validateScoreLeakage(generatedExplanation.text, errors);
        validateUnsupportedReasonClaims(explanationPlan, generatedExplanation.text, errors);
        validateSelectedReasonSafety(explanationPlan, generatedExplanation.text, errors);
        validatePracticalSupport(explanationPlan, generatedExplanation.text, errors);
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

module.exports = {
    ERROR_CODES,
    validateExplanationGrounding
};
