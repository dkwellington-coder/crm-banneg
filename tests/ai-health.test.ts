import { describe, expect, it } from "vitest";
import { aiAccountProblem } from "@/lib/ai-health";

const err = (status: number, message: string) => Object.assign(new Error(message), { status });

describe("aiAccountProblem", () => {
  it("names the account problems that stop Duda and Alice", () => {
    expect(aiAccountProblem(err(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing"}}'))).toMatch(
      /sem crédito.*console\.anthropic\.com/,
    );
    expect(aiAccountProblem(err(401, '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toMatch(/ANTHROPIC_API_KEY/);
    expect(aiAccountProblem(err(403, '403 {"type":"error","error":{"type":"permission_error"}}'))).toMatch(/permissão/);
  });

  it("leaves out what passes on its own: overload, rate limit, a timeout, a bad request of ours", () => {
    expect(aiAccountProblem(err(529, "Overloaded"))).toBeNull();
    expect(aiAccountProblem(err(429, "rate_limit_error"))).toBeNull();
    expect(aiAccountProblem(new Error("Request timed out."))).toBeNull();
    expect(aiAccountProblem(err(400, "messages: text content blocks must be non-empty"))).toBeNull();
    expect(aiAccountProblem(null)).toBeNull();
  });
});
