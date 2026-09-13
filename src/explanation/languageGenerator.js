const {
    resolveStoredLanguage
} = require("./languageResolver");

const GENERATION_STATUS = Object.freeze({
    GENERATED: "generated",
    NEUTRAL_FALLBACK_REQUIRED: "neutral_fallback_required"
});

const AR_LABELS = Object.freeze({
    Robotics: "الروبوتات",
    STEM: "العلوم والتقنية",
    "Problem Solving": "حل المشكلات",
    "Improve Problem Solving": "تحسين حل المشكلات",
    Indoor: "داخلي",
    Outdoor: "خارجي",
    Mixed: "متنوع",
    Team: "جماعي",
    Individual: "فردي",
    Beginner: "مبتدئ",
    Intermediate: "متوسط",
    Advanced: "متقدم",
    Structured: "منظم",
    Creative: "إبداعي",
    Exploratory: "استكشافي",
    OneTime: "مرة واحدة",
    Weekly: "أسبوعي",
    Monday: "الإثنين",
    Tuesday: "الثلاثاء",
    Wednesday: "الأربعاء",
    Thursday: "الخميس",
    Friday: "الجمعة",
    Saturday: "السبت",
    Sunday: "الأحد"
});

const EN_DIMENSIONS = Object.freeze({
    environment: "environment",
    socialStyle: "social setting",
    difficulty: "difficulty level",
    experienceStyle: "experience style",
    commitmentPreference: "commitment style"
});

const AR_DIMENSIONS = Object.freeze({
    environment: "البيئة",
    socialStyle: "الأسلوب الاجتماعي",
    difficulty: "مستوى الصعوبة",
    experienceStyle: "أسلوب التجربة",
    commitmentPreference: "نوع الالتزام"
});

function isPlainObject(value) {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
}

function validateExplanationPlan(plan) {
    if (!isPlainObject(plan)) {
        throw new Error("Explanation Plan is required");
    }

    if (!Array.isArray(plan.reasonTypes)) {
        throw new Error("Explanation Plan reasonTypes must be an array");
    }

    if (!Array.isArray(plan.reasons)) {
        throw new Error("Explanation Plan reasons must be an array");
    }

    if (plan.reasonTypes.length !== plan.reasons.length) {
        throw new Error("Explanation Plan reasonTypes and reasons must align");
    }

    for (let index = 0; index < plan.reasons.length; index += 1) {
        if (plan.reasons[index]?.type !== plan.reasonTypes[index]) {
            throw new Error("Explanation Plan reason order is invalid");
        }
    }
}

function renderValue(value, language) {
    if (Array.isArray(value)) {
        return value.map((item) => renderValue(item, language)).join(
            language === "ar" ? "، " : ", "
        );
    }

    if (value === null || value === undefined) {
        return language === "ar" ? "المناسب" : "the suitable option";
    }

    const text = String(value);

    if (language === "ar") {
        return AR_LABELS[text] ?? text;
    }

    return text;
}

function activityName(activity, language) {
    if (language === "ar") {
        return activity?.nameAr ?? activity?.nameEn ?? "";
    }

    return activity?.nameEn ?? activity?.nameAr ?? "";
}

function renderReferenceName(reference, language) {
    return renderValue(reference?.name, language);
}

function firstMatchedOutcome(reason) {
    if (!Array.isArray(reason.matchedOutcomes)) {
        return null;
    }

    return reason.matchedOutcomes.find((outcome) =>
        outcome?.resolved === true &&
        typeof outcome.name === "string" &&
        outcome.name.trim().length > 0
    ) ?? reason.matchedOutcomes[0] ?? null;
}

function englishReason(reason) {
    if (reason.type === "interest") {
        if (reason.supportType === "exact_subcategory_interest") {
            return `your child has shown interest in ${renderReferenceName(reason.subcategory, "en")} before`;
        }

        return `it gives your child a broader opportunity related to ${renderReferenceName(reason.category, "en")}`;
    }

    if (reason.type === "preference") {
        const dimension = EN_DIMENSIONS[reason.dimension] ?? reason.dimension;

        return `it fits a known ${dimension} preference for ${renderValue(reason.activityValue, "en")}`;
    }

    if (reason.type === "goal") {
        const goal = renderReferenceName(reason.goal, "en");
        const outcome = firstMatchedOutcome(reason);

        if (outcome) {
            return `it aligns with the goal you selected, ${goal}, through practice around ${renderReferenceName(outcome, "en")}`;
        }

        return `it aligns with the goal you selected, ${goal}`;
    }

    if (reason.type === "exploration") {
        if (reason.noveltyState === "new") {
            return "it offers something new to try";
        }

        return "it offers a less familiar activity to try";
    }

    if (reason.type === "behavior") {
        const action = englishBehaviorAction(reason.selectedInteractionType);

        if (reason.actorAttribution === "child") {
            return `your child previously ${action} this activity`;
        }

        if (reason.actorAttribution === "parent") {
            return `it reflects previous parent engagement: this activity was ${action}`;
        }

        return `it reflects previous engagement with this activity: ${action}`;
    }

    if (reason.type === "session") {
        return `an eligible session matches a preferred day: ${renderValue(reason.matchingWeekdays, "en")}`;
    }

    return null;
}

function arabicReason(reason) {
    if (reason.type === "interest") {
        if (reason.supportType === "exact_subcategory_interest") {
            return `طفلك أظهر اهتماما بـ ${renderReferenceName(reason.subcategory, "ar")} من قبل`;
        }

        return `يوفر فرصة أوسع مرتبطة بمجال ${renderReferenceName(reason.category, "ar")}`;
    }

    if (reason.type === "preference") {
        const dimension = AR_DIMENSIONS[reason.dimension] ?? "التفضيل";

        return `يناسب ${dimension} المعروف: ${renderValue(reason.activityValue, "ar")}`;
    }

    if (reason.type === "goal") {
        const goal = renderReferenceName(reason.goal, "ar");
        const outcome = firstMatchedOutcome(reason);

        if (outcome) {
            return `يتوافق مع الهدف الذي اخترته، ${goal}، من خلال ممارسة مرتبطة بـ ${renderReferenceName(outcome, "ar")}`;
        }

        return `يتوافق مع الهدف الذي اخترته، ${goal}`;
    }

    if (reason.type === "exploration") {
        if (reason.noveltyState === "new") {
            return "يوفر شيئا جديدا للتجربة";
        }

        return "يوفر نشاطا أقل ألفة يمكن تجربته";
    }

    if (reason.type === "behavior") {
        const action = arabicBehaviorAction(reason.selectedInteractionType);

        if (reason.actorAttribution === "child") {
            return `طفلك سبق أن ${action} هذا النشاط`;
        }

        if (reason.actorAttribution === "parent") {
            return `يعكس تفاعلا سابقا من ولي الأمر: تم ${action} هذا النشاط`;
        }

        return `يعكس تفاعلا سابقا مع هذا النشاط: ${action}`;
    }

    if (reason.type === "session") {
        return `توجد حصة مؤهلة توافق يوما مفضلا: ${renderValue(reason.matchingWeekdays, "ar")}`;
    }

    return null;
}

function englishBehaviorAction(interactionType) {
    const actions = {
        Save: "saved",
        Book: "booked",
        Attend: "attended",
        Complete: "completed",
        Unsave: "unsaved",
        Dismiss: "dismissed",
        Rate: "rated",
        View: "viewed",
        Click: "clicked"
    };

    return actions[interactionType] ?? "engaged with";
}

function arabicBehaviorAction(interactionType) {
    const actions = {
        Save: "حفظ",
        Book: "حجز",
        Attend: "حضر",
        Complete: "أكمل",
        Unsave: "أزال حفظ",
        Dismiss: "صرف",
        Rate: "قيّم",
        View: "شاهد",
        Click: "فتح"
    };

    return actions[interactionType] ?? "تفاعل مع";
}

function buildLocalText(plan, language) {
    const name = activityName(plan.activity, language);
    const reasonFragments = plan.reasons
        .map((reason) => language === "ar"
            ? arabicReason(reason)
            : englishReason(reason))
        .filter(Boolean);

    if (language === "ar") {
        const intro = name ? `اقترحنا ${name} لأن` : "اقترحنا هذا النشاط لأن";

        return `${intro} ${joinReasons(reasonFragments, "ar")}.`;
    }

    const intro = name ? `We suggested ${name} because` : "We suggested this activity because";

    return `${intro} ${joinReasons(reasonFragments, "en")}.`;
}

function joinReasons(reasons, language) {
    if (reasons.length === 0) {
        return language === "ar"
            ? "هو من الخيارات المؤهلة حاليا"
            : "it is one of the currently eligible options";
    }

    if (reasons.length === 1) {
        return reasons[0];
    }

    if (reasons.length === 2) {
        return reasons.join(language === "ar" ? "، و" : " and ");
    }

    const last = reasons[reasons.length - 1];
    const leading = reasons.slice(0, -1).join(language === "ar" ? "، " : ", ");

    return language === "ar"
        ? `${leading}، و${last}`
        : `${leading}, and ${last}`;
}

async function realizeWithProvider(provider, plan, language) {
    let response;

    try {
        response = await provider.generate({
            language,
            explanationPlan: buildProviderExplanationPlan(plan, language),
            contract: {
                role: "language_realization_only",
                noReasonSelection: true,
                noAdditionalFacts: true,
                noScoresWeightsOrContributions: true
            }
        });
    } catch (error) {
        throw new Error(
            `Explanation language provider failed: ${error.message}`,
            { cause: error }
        );
    }

    if (
        !response ||
        typeof response.text !== "string" ||
        response.text.trim().length === 0
    ) {
        throw new Error("Explanation language provider returned malformed output");
    }

    return response.text;
}

function buildProviderExplanationPlan(plan, language) {
    return {
        language,
        activity: {
            displayName: activityName(plan.activity, language)
        },
        reasonTypes: clone(plan.reasonTypes),
        reasons: plan.reasons.map((reason) =>
            buildProviderReason(reason, language)
        )
    };
}

function buildProviderReason(reason, language) {
    if (reason.type === "interest") {
        if (reason.supportType === "exact_subcategory_interest") {
            return {
                type: "interest",
                supportType: reason.supportType,
                subject: renderReferenceName(reason.subcategory, language)
            };
        }

        return {
            type: "interest",
            supportType: reason.supportType,
            category: renderReferenceName(reason.category, language)
        };
    }

    if (reason.type === "preference") {
        return {
            type: "preference",
            dimension: reason.dimension,
            childPreference: renderValue(reason.childValue, language),
            activityValue: renderValue(reason.activityValue, language)
        };
    }

    if (reason.type === "goal") {
        const outcome = firstMatchedOutcome(reason);

        return {
            type: "goal",
            goal: renderReferenceName(reason.goal, language),
            outcome: outcome ? renderReferenceName(outcome, language) : null
        };
    }

    if (reason.type === "exploration") {
        return {
            type: "exploration",
            noveltyState: reason.noveltyState
        };
    }

    if (reason.type === "behavior") {
        return {
            type: "behavior",
            actorAttribution: reason.actorAttribution,
            interactionType: reason.selectedInteractionType
        };
    }

    if (reason.type === "session") {
        return {
            type: "session",
            matchingWeekdays: renderValue(reason.matchingWeekdays, language)
        };
    }

    return {
        type: reason.type
    };
}

async function generateExplanation(explanationPlan, dependencies = {}) {
    validateExplanationPlan(explanationPlan);

    const language = resolveStoredLanguage({
        parent: dependencies.parent
    });
    const reasonTypes = clone(explanationPlan.reasonTypes);

    if (explanationPlan.neutralFallbackRequired === true) {
        return {
            reasonTypes,
            language,
            status: GENERATION_STATUS.NEUTRAL_FALLBACK_REQUIRED,
            text: null
        };
    }

    const text = dependencies.provider
        ? await realizeWithProvider(
            dependencies.provider,
            explanationPlan,
            language
        )
        : buildLocalText(explanationPlan, language);

    return {
        reasonTypes,
        language,
        status: GENERATION_STATUS.GENERATED,
        text
    };
}

module.exports = {
    GENERATION_STATUS,
    buildProviderExplanationPlan,
    generateExplanation
};
