import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const accountClaimsSchema = Type.Object({ "https://api.openai.com/auth": Type.Object({ chatgpt_account_id: Type.String({ minLength: 1 }) }) });

export function codexTokenClaims<Schema extends TSchema>(token: string, schema: Schema): Static<Schema> {
  return Value.Parse(schema, JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()));
}

export function codexAccountId(token: string): string {
  return codexTokenClaims(token, accountClaimsSchema)["https://api.openai.com/auth"].chatgpt_account_id;
}
