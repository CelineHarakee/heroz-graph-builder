function calculateAge(dateOfBirth, today = new Date()) {
    if (!dateOfBirth) {
        return null;
    }

    const birthDate = new Date(dateOfBirth);

    if (Number.isNaN(birthDate.getTime())) {
        return null;
    }

    const currentDate = new Date(today);

    if (Number.isNaN(currentDate.getTime())) {
        return null;
    }

    let age =
        currentDate.getFullYear() -
        birthDate.getFullYear();

    const birthdayHasOccurred =
        currentDate.getMonth() > birthDate.getMonth() ||
        (
            currentDate.getMonth() === birthDate.getMonth() &&
            currentDate.getDate() >= birthDate.getDate()
        );

    if (!birthdayHasOccurred) {
        age -= 1;
    }

    return age;
}

module.exports = {
    calculateAge
};
