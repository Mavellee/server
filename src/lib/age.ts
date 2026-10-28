/** Age in whole years, computed on the server from the private date of birth. */
export function ageFrom(dob: Date, now = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/** Latest birth date that makes someone `years` old today. */
export function birthDateForAge(years: number, now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
}
