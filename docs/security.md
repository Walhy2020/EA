# Security Notes

Rules for this project:

- Keep real secrets in `.env` or untracked config files only.
- Commit only `.example` files.
- Mask keys named `secret`, `apiKey`, `token`, `webhook`, `encodingAesKey`, `password`, or similar before logging.
- Do not log complete DeepSeek prompts unless explicitly debugging on a private machine.
- Do not expose the admin console to the public internet.
- On Win10, bind to `127.0.0.1` by default. Use `0.0.0.0` only for company intranet access.
- Back up config files before moving the service to another machine.
- When robot logging is enabled, log message length and route metadata by default, not full colleague questions.
