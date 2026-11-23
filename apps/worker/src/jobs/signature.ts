/** The signature from Settings goes under every draft, once: the model is told not to write one. */
export function appendSignature(body: string, signature: string): string {
  const sig = signature.trim();
  if (!sig || body.trimEnd().endsWith(sig)) return body.trimEnd();
  return `${body.trimEnd()}\n\n${sig}`;
}
