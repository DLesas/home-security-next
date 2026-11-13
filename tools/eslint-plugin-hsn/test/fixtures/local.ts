// A class that is named Result but is not neverthrow's, so the rule must leave it alone.
export class Result {
  readonly done = true;
}
export function notNeverthrow(): Result {
  return new Result();
}
