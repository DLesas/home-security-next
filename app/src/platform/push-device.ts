/** The web build and Bun do not own native push registrations. */
export const hasPushRegistration: (hub: string) => Promise<boolean> = () => Promise.resolve(false);
