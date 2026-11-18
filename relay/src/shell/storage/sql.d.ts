/** A migration's SQL, imported as text (`with { type: "text" }`), so a compiled program carries it. */
declare module "*.sql" {
  const text: string;
  export default text;
}
