MERGE (c:Child {childId: $childId})
SET
    c.firstName = $firstName,
    c.lastName = $lastName,
    c.age = $age,
    c.gender = $gender