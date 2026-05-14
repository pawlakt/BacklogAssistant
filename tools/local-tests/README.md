# Local Work Item Test Scripts

Edit base values in `messages.config.ps1`, then run from `cmd`:

Messages:
- `tools\local-tests\messages-post.cmd`
- `tools\local-tests\messages-get.cmd`

Draft:
- `tools\local-tests\draft-post.cmd`
- `tools\local-tests\draft-get.cmd`

What to edit in `messages.config.ps1`:

- `$BaseUrl`
- `$WorkItemId`
- `$Headers` (especially `x-ado-*`)
- `$PostMessage`

What to edit in `draft.config.ps1`:

- `$DraftBody` (default is `{}` and is usually enough for `POST /draft`)

Output includes:

- HTTP status
- response headers
- pretty JSON body (when body is JSON)

Encoding note:

- `.cmd` scripts switch terminal to UTF-8 (`chcp 65001`).
- `common.ps1` also forces UTF-8 output for proper Polish characters.
