// Random numbers are not the browser's alone: wave 0 checks the phone's engine has them.
// Expect: clean
export const bytes = crypto.getRandomValues(new Uint8Array(8));
