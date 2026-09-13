const { GENERATION_STATUS } = require("./languageGenerator");

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

function clone(value) {
    if (value === undefined) {
        return undefined;
    }

    return JSON.parse(JSON.stringify(value));
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

    return language === "ar" ? AR_LABELS[text] ?? text : text;
}

function activityName(activity, language) {
    return language === "ar"
        ? activity?.nameAr ?? activity?.nameEn ?? ""
        : activity?.nameEn ?? activity?.nameAr ?? "";
}

function referenceName(reference, language) {
    return renderValue(reference?.name, language);
}

function matchedOutcome(reason) {
    return Array.isArray(reason.matchedOutcomes)
        ? reason.matchedOutcomes.find((outcome) => outcome?.resolved === true) ??
            reason.matchedOutcomes[0]
        : null;
}

function behaviorAction(type, language) {
    const en = {
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
    const ar = {
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

    return language === "ar"
        ? ar[type] ?? "تفاعل مع"
        : en[type] ?? "engaged with";
}

function englishReason(reason) {
    if (reason.type === "interest") {
        return reason.supportType === "exact_subcategory_interest"
            ? `It connects with a demonstrated interest in ${referenceName(reason.subcategory, "en")}.`
            : `It gives a broader opportunity related to ${referenceName(reason.category, "en")}.`;
    }

    if (reason.type === "preference") {
        return `It fits a known preference around ${renderValue(reason.activityValue, "en")}.`;
    }

    if (reason.type === "goal") {
        const outcome = matchedOutcome(reason);

        return outcome
            ? `It supports ${referenceName(reason.goal, "en")} through practice around ${referenceName(outcome, "en")}.`
            : `It supports ${referenceName(reason.goal, "en")}.`;
    }

    if (reason.type === "exploration") {
        return reason.noveltyState === "new"
            ? "It offers a new activity to explore."
            : "It offers a less familiar activity to explore further.";
    }

    if (reason.type === "behavior") {
        const action = behaviorAction(reason.selectedInteractionType, "en");

        if (reason.actorAttribution === "child") {
            return `It reflects that your child previously ${action} this activity.`;
        }

        if (reason.actorAttribution === "parent") {
            return `It reflects previous parent engagement: this activity was ${action}.`;
        }

        return `It reflects previous engagement with this activity: ${action}.`;
    }

    if (reason.type === "session") {
        return `An eligible session matches a preferred day: ${renderValue(reason.matchingWeekdays, "en")}.`;
    }

    return null;
}

function arabicReason(reason) {
    if (reason.type === "interest") {
        return reason.supportType === "exact_subcategory_interest"
            ? `يرتبط باهتمام موثق في ${referenceName(reason.subcategory, "ar")}.`
            : `يوفر فرصة أوسع مرتبطة بمجال ${referenceName(reason.category, "ar")}.`;
    }

    if (reason.type === "preference") {
        return `يناسب تفضيلا معروفا حول ${renderValue(reason.activityValue, "ar")}.`;
    }

    if (reason.type === "goal") {
        const outcome = matchedOutcome(reason);

        return outcome
            ? `يدعم ${referenceName(reason.goal, "ar")} من خلال ممارسة مرتبطة بـ ${referenceName(outcome, "ar")}.`
            : `يدعم ${referenceName(reason.goal, "ar")}.`;
    }

    if (reason.type === "exploration") {
        return reason.noveltyState === "new"
            ? "يوفر نشاطا جديدا للاستكشاف."
            : "يوفر نشاطا أقل ألفة يمكن استكشافه أكثر.";
    }

    if (reason.type === "behavior") {
        const action = behaviorAction(reason.selectedInteractionType, "ar");

        if (reason.actorAttribution === "child") {
            return `يعكس أن طفلك سبق أن ${action} هذا النشاط.`;
        }

        if (reason.actorAttribution === "parent") {
            return `يعكس تفاعلا سابقا من ولي الأمر: تم ${action} هذا النشاط.`;
        }

        return `يعكس تفاعلا سابقا مع هذا النشاط: ${action}.`;
    }

    if (reason.type === "session") {
        return `توجد حصة مؤهلة توافق يوما مفضلا: ${renderValue(reason.matchingWeekdays, "ar")}.`;
    }

    return null;
}

function buildFallbackText(plan, language) {
    const name = activityName(plan.activity, language);

    if (
        plan.neutralFallbackRequired === true ||
        plan.reasonTypes.length === 0
    ) {
        return language === "ar"
            ? "هذا النشاط من الخيارات المؤهلة المتاحة حاليا لهذه التوصية."
            : "This activity is one of the currently eligible options available for this recommendation.";
    }

    const reasons = plan.reasons.map((reason) =>
        language === "ar" ? arabicReason(reason) : englishReason(reason)
    ).filter(Boolean);
    if (language === "ar") {
        const intro = name
            ? `نوصي بـ ${name} للأسباب التالية.`
            : "نوصي بهذا النشاط للأسباب التالية.";

        return [intro, ...reasons].filter(Boolean).join(" ");
    }

    const intro = name
        ? `We recommend ${name} for these reasons.`
        : "We recommend this activity for these reasons.";

    return [intro, ...reasons].filter(Boolean).join(" ");
}

function buildFallbackExplanation(explanationPlan, language) {
    if (language !== "en" && language !== "ar") {
        throw new Error("Fallback language must be en or ar");
    }

    return {
        reasonTypes: clone(explanationPlan.reasonTypes),
        language,
        status: GENERATION_STATUS.GENERATED,
        text: buildFallbackText(explanationPlan, language)
    };
}

module.exports = {
    buildFallbackExplanation
};
