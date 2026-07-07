## Summary

What does this change and why? Reference the relevant `PLAN.md` phase if
applicable.

## Changes

-
-

## Testing

- [ ] `cd agent && npm run typecheck` passes
- [ ] `FOUNDATION_OFFLINE=1 npm run smoke` ends with `✅ foundation smoke passed`
- [ ] (if online behavior changed) verified with real keys

## Checklist

- [ ] No secrets committed (`.env`, keys, tokens)
- [ ] Public APIs of `openclaw-client.ts` / `blocks-client.ts` unchanged
      (or all callers updated)
- [ ] Updated `README.md` / `PLAN.md` / `TASKS.md` if behavior/scope changed
