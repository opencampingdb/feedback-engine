# The AI reviewer's second stage calls Anthropic's API with a Worker secret

The AI reviewer runs on Workers AI, through the intake's own binding, so it needs no model key (ADR 0002). Cases its model is unsure of went to a person, and too many of them still did. The reviewer now has a second stage: a case the first model is unsure of is asked again of Claude Haiku 5.5 on Anthropic's API. That call needs an API key, so the intake takes one as the Worker secret `ANTHROPIC_API_KEY`.

The key is a secret, set with `wrangler secret put` and never written to a repository, a deploy copy or a log. The stage is optional: without the key it is off, and unsure cases go to a person as before. It is capped: each answer's cost is worked out from the token usage the API reports and added to a monthly total in D1, the stage is asked only while the total is under `SECOND_REVIEW_CAP_USD` (US$20 by default), and over the cap a case goes to a person as `ai_cap`. A call that fails, times out or whose spending cannot be read or written leaves the case for a person, so an outage or a broken total never lets a case through. The rules settle owner values and verified owners before either model is asked.

## Considered options

- **A larger Workers AI model for the second stage.** It would need no key, but the moderation spec (#134) names Claude Haiku 5.5 for the second stage, a model Workers AI does not serve.
- **No second stage.** Every unsure case stays with a person, which the maintainer wants kept to edge cases.
- **Spend tracked by Anthropic's console only.** A spending limit there stops the key for every use of the account, and the intake would not know why its calls fail. A cap the intake keeps itself turns into `ai_cap` and a person.

## Consequences

ADR 0002's statement that no model key lives in the public repositories still holds, but the intake can now hold one, as a Worker secret, and a deployment that sets it pays Anthropic for the second stage up to its cap. The monthly total is in the `ai_spend` table (migration `0017`). The self-hosting guide lists the secret and the cap, and the intake depends on `@anthropic-ai/sdk`.
