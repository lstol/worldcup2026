# WorldCup 2026 - Family Prediction App

## Project overview
Single `index.html` file, vanilla JavaScript, no frameworks.
Hosted on GitHub Pages at lstol.github.io/worldcup2026.
Supabase backend for data persistence and authentication.
DNS alias: vm2026.syndikatet.eu → GitHub Pages.

## Infrastructure
- Supabase project URL: agreoglnwnesdekjbacu.supabase.co
- GitHub repo: github.com/lstol/worldcup2026
- Admin user: lasse.stoltenberg@gmail.com (ADMIN_EMAIL constant in code)

## Architecture
- Single index.html contains all HTML, CSS and JavaScript inline
- Vanilla JS only — no React, Vue or other frameworks
- Supabase handles database, authentication and RLS policies
- Family members log in and submit predictions via the web app
- Admin (Lasse) manages players, updates match results, controls settings

## JavaScript conventions
- No template literals or backticks in JS strings — use string concatenation
- No arrow functions — use function() syntax throughout
- Unescaped apostrophes inside single-quoted JS strings in onclick
  attributes must use &apos;

## Working style
- Validate JS syntax before every commit using `npx acorn --ecma2020`
  (extract inline script first: `re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>', ...)`)
- Prefer complete, thorough changes over small incremental patches
- Commit regularly with descriptive messages

---

## Database schema

### `matches`
| Column         | Type        | Notes                                      |
|----------------|-------------|--------------------------------------------|
| id             | int         | Primary key (auto-increment, NOT sequential with match_number) |
| match_number   | int         | 1–104; used as display label and sort key  |
| round          | text        | 'group', 'R32', 'R16', 'QF', 'SF', 'final', 'bronze' |
| group_letter   | text        | A–L (group stage only)                     |
| home_team      | text        | May be placeholder like 'Winner Group A'   |
| away_team      | text        | May be placeholder                         |
| home_score     | int         | NULL until result entered                  |
| away_score     | int         | NULL until result entered                  |
| match_date     | date        | DATE type — no time component              |
| kickoff_utc    | TIMESTAMPTZ | Exact kickoff time in UTC (added later)    |

**Important:** `matches.id` is an auto-increment integer and is NOT equal to
`match_number`. E.g. match_number=1 has id=73. Code uses `m.id` for FK references
(predictions, admin inputs) and `m.match_number` only for display.

### `predictions`
| Column       | Type  | Notes                                               |
|--------------|-------|-----------------------------------------------------|
| id           | int   | Primary key (auto-increment)                        |
| player_id    | UUID  | FK → players.id                                     |
| match_id     | int   | FK → matches.id (NOT match_number)                  |
| home_score   | int   | Player's predicted home score                       |
| away_score   | int   | Player's predicted away score                       |
| et_winner    | char  | Knockout only — 'H' or 'A'                         |
| submitted_at | TIMESTAMPTZ | Set automatically                             |

Unique constraint: `(player_id, match_id)` — used as the upsert conflict target.

### `players`
| Column     | Type        | Notes                                           |
|------------|-------------|-------------------------------------------------|
| id         | UUID        | Should equal auth.users.id for that player      |
| name       | text        | Display name                                    |
| email      | text        | UNIQUE (two constraints: players_email_key and players_email_unique) |
| is_admin   | bool        | Default false                                   |
| created_at | TIMESTAMPTZ | Default now()                                   |
| chat_last_seen | TIMESTAMPTZ | Last time the player viewed the chat; drives @mention notifications |

**Important:** `players.id` must equal `auth.users.id` for RLS to work correctly.
New players created via Settings → Add Player will have this set correctly.

**Source of truth:** The Settings player list (i.e. `public.players`) is
authoritative. `auth.users` must mirror it — never the other way around.

**Invariants enforced by the DB:**
- A trigger (`on_player_delete`) fires `AFTER DELETE ON players` and deletes the
  corresponding `auth.users` row via `public.delete_auth_user_on_player_delete()`
  (SECURITY DEFINER). Removing a player via the UI fully cleans up both tables.
- The RPC `public.admin_create_player(p_email, p_name)` (SECURITY DEFINER,
  admin-only) absorbs any orphan in `auth.users` back into `players`. The client
  calls it when `signUp()` reports "already registered" — it looks up the
  existing auth UUID, inserts a matching `players` row with that UUID, and
  returns it. Net effect: orphans no longer block re-adding the same email.

### `chat_messages`
| Column     | Type        | Notes                                            |
|------------|-------------|--------------------------------------------------|
| id         | bigint      | identity PK                                      |
| player_id  | UUID        | FK → players.id (ON DELETE CASCADE)              |
| message    | text        | ≤1000 chars                                      |
| created_at | TIMESTAMPTZ | default now()                                    |

Family chat shown at the top of the Standings page. RLS: public read; insert
where `player_id = auth.uid()`; delete own or admin. Added to the
`supabase_realtime` publication — `setupChatRealtime()` (called once after boot)
subscribes to INSERTs for instant delivery; a 12s poll (`startChatPoll`) stays
as a fallback while the page is open. New messages arriving while you're on
another page bump an unread badge on the Standings nav button (`#lbbtn` /
`updateChatBadge`), cleared on entering Standings. **@mentions:** typing `@`
opens a player autocomplete (`chatMentionInput`/`pickMention`/`chatKey`);
rendered messages highlight `@Name` tokens (`chatHighlight`), and a message that
tags you gets an amber left border. **Mention notifications:** `players.chat_last_seen` records when each player last opened the chat (updated by `markChatSeen` on entering Standings). On login `checkChatMentions()` queries messages newer than that which contain `@<my name>` and shows an amber `#mention-banner` ("X tagged you in chat — Open chat" via `gotoChat`); live `@`-mentions while you're elsewhere show the same banner and turn the Standings badge amber (`@N`). `sendChat`/`deleteChatMsg`/`loadChat`/
`renderChatMessages` manage the rest. The chat box lives in `lb-main` outside
`lb-content`, so renderLB re-renders don't disturb it.

### `settings`
Key/value table. Has two value columns: `value` (integer, NOT NULL) and `text_value` (text, nullable).
Known keys:
| Key            | Default | Column      | Meaning                                     |
|----------------|---------|-------------|---------------------------------------------|
| gs_exact       | 5       | value       | Points for exact score in group stage       |
| gs_result      | 2       | value       | Points for correct result in group stage    |
| ko_exact       | 5       | value       | Points for exact score in knockout rounds   |
| ko_result      | 2       | value       | Points for correct result in knockout rounds|
| bonus_r32      | -       | value       | Bonus pts for predicting a team reaching R32 |
| bonus_r16      | -       | value       | Bonus pts for R16                           |
| bonus_qf       | -       | value       | Bonus pts for QF                            |
| bonus_sf       | -       | value       | Bonus pts for SF                            |
| bonus_final    | -       | value       | Bonus pts for Final                         |
| preds_visible  | 0       | value       | Whether all players can see each other's predictions AND each other's bonus answers (the bonus page shows an "Everyone's Answers" tabbed viewer — player/bot tabs like View Predictions — when this is on, for non-admins) |
| anthropic_key  | -       | text_value  | Anthropic API key for Claude bot (admin only) |
| invite_message | -       | text_value  | Body text of welcome email; use `{name}` as placeholder for player name |

In `loadAll`, settings are parsed as:
```javascript
settings[r.key] = r.value;
if (r.text_value) settings[r.key + '__text'] = r.text_value;
```
So `anthropic_key__text` holds the API key and is auto-loaded into `anthropicKey` for admin on boot.
And `invite_message__text` is the editable invite body text.

---

## RLS policies

### `players` table
- `read_all`: USING (true) — any authenticated user can read all rows
- `admin_insert`: WITH CHECK: EXISTS (SELECT 1 FROM players WHERE id = auth.uid() AND is_admin = true)
- `admin_update`: USING: same admin check
- `admin_delete`: USING: same admin check
- `self_update_name`: USING (id = auth.uid()) WITH CHECK (id = auth.uid()) — players can update their own row

**Important:** The admin RLS policies check `players.is_admin = true` using `auth.uid()`. The app also
grants admin rights via `ADMIN_EMAIL` constant in JS, but the DB row must have `is_admin = true` for
DB-level operations (insert/update/delete other players) to work. Lasse's row (`lasse.stoltenberg@gmail.com`)
has been confirmed set to `is_admin = true`.

### `predictions` table
- `public read predictions`: USING (true) — all authenticated users can read
- `players insert own`: WITH CHECK (player_id = auth.uid()) — players can insert their own
- `players update own`: USING (player_id = auth.uid()) — players can update their own
- `players delete own`: USING (player_id = auth.uid()) — players can delete their own
- `Admin can delete any predictions`: USING (admin check) — admin can delete any row
- `admin insert any predictions`: WITH CHECK (admin check) — admin can insert for any player_id (needed for bot players)
- `admin update any predictions`: USING (admin check) — admin can update for any player_id

---

## Key JavaScript functions

### Authentication / boot
- `padPassword(p)`: pads passwords shorter than 6 chars with underscores
  (Supabase enforces 6-char minimum server-side). Applied transparently in
  `doLogin`, `doChangePassword`, and `sendInvite` — players never see underscores.
- `bootApp(user)`: called after login. Fetches the player's row; if no row
  exists (deleted/ghost account) and email ≠ ADMIN_EMAIL, signs out immediately.
  Checks `user.user_metadata.must_change_password` and shows the change-password
  screen on first login.
- `loadAll()`: fetches matches (with kickoff_utc), predictions for current
  player, all players, and settings in parallel.
- Startup uses `sb.auth.getUser()` (not `getSession()`) so deleted auth users
  are rejected server-side rather than booting from a stale cached token.

### Player save / invite flow (Settings → Add Player)
Save and invite are separate actions. Persisting a player to the DB is done by
`savePlayerRow(row)`; sending the welcome email is done by `sendInvite(btn)`.

`savePlayerRow(row)` is called from:
- `saveAllSettings()` and `savePlayerNames()` — bulk-save every row in
  `#players-tbody` without `data-pid` that has both name and email filled.
- `sendInvite(btn)` — when the row has no `data-pid` yet, save first, then
  send the email.

**Session isolation (critical):** `signUp()` auto-signs-in the new user on
autoconfirm projects. To stop that from replacing the admin's session, signup
runs on a **dedicated throwaway client** `sbSignup` created alongside `sb`:
`supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false,
autoRefreshToken: false, storageKey: 'wc2026-signup-temp' } })`. Because
`persistSession:false`, the new user's auto-login never reaches localStorage, so
the admin's `sb` session is untouched — no getSession/setSession juggling. (The
old save/restore-token workaround was fragile: it failed with
`refresh_token_not_found` and left the admin "logged in as the latest added
participant." Do NOT reintroduce it.)

Steps inside `savePlayerRow`:
1. Resolve the invite body (`settings['invite_message__text']`, re-fetched from
   the DB if blank).
2. Call `sbSignup.auth.signUp()` with the player's email and `padPassword(name)`
   — on the throwaway client, so the admin session is never replaced.
3. If `signUp` returned "already registered" (orphan in `auth.users` or
   existing player), call `sb.rpc('admin_create_player', {p_email, p_name})`.
   The RPC ensures a `players` row exists for the auth UUID and returns it.
4. Otherwise upsert `players` with `{ id: authUUID, name, email, is_admin: false }`.
5. Flip the row UI: set `data-pid`, badge → "Saved" (green), button →
   "Invite", drop the Cancel button, mark the email field readonly.

`sendInvite(btn)` first calls the `admin_refresh_invite_metadata(p_email)` RPC,
then `sb.auth.resetPasswordForEmail(email)` — Supabase sends no email on
`signUp()` when autoconfirm is on, so the customised "Reset Password" template
is the welcome-invite delivery mechanism.

**Why the refresh RPC matters:** the email template renders
`{{ .Data.invite_message }}` from each user's *frozen* auth metadata (set at
signUp time), NOT directly from the live `settings.invite_message`. So editing
the Settings message would otherwise NOT reach already-created players on
re-invite. `public.admin_refresh_invite_metadata(p_email)` (SECURITY DEFINER,
admin-only) re-reads `settings.invite_message`, substitutes `{name}`, and writes
the result (plus the resolved `name`) into that user's `auth.users`
`raw_user_meta_data` immediately before the email is sent. Net effect: **hitting
Re-invite always delivers the current Settings message** to any player.
Hardening: `savePlayerRow` also re-fetches `settings.invite_message` from the DB
when the in-memory copy is blank, so new signups can't bake in an empty message
(the original cause of some early "empty invitation" emails).

**Initial password** = player's name as entered by admin (e.g. "Alma"),
padded with underscores if under 6 chars. Players are told their initial
password in the welcome email and never see the padding.

**Welcome email template** is configured in Supabase dashboard under
Authentication → Email Templates → Reset Password. Template uses:
- `{{ .Email }}` — player's email address
- `{{ .Data.name }}` — player's name (set in signUp user metadata)
- `{{ .Data.invite_message }}` — editable body text from `settings.invite_message`; use `{name}` placeholder in the settings field and it is replaced with the player's name before being passed to signUp metadata
- Plain link to `https://vm2026.syndikatet.eu` (no magic link / recovery token)
- No `{{ .ConfirmationURL }}` — players simply go to the login page directly.

The invite message is stored as plain text with `\n` newlines. The template should render it with:
```html
<p style="white-space: pre-line">{{ .Data.invite_message }}</p>
```
This ensures line breaks typed in the Settings textarea appear as line breaks in the email.

**Email sending (Custom SMTP via Gmail).** Auth emails (invites / password
resets) are sent through **Custom SMTP** configured in the Supabase dashboard
(Project Settings → Authentication → SMTP Settings), using a **personal Gmail
account**, not Supabase's default sender. Settings: host `smtp.gmail.com`,
port `465`, username = the Gmail address, password = a Google **App Password**
(requires 2-Step Verification enabled on that Google account — the normal
password will NOT work), sender email = same Gmail address.
- The "from" address is the Gmail address (e.g. `name@gmail.com`), NOT
  `@syndikatet.eu`. The domain has no email service and paying for one isn't
  worth it at this scale. No SPF/DKIM/DMARC changes on syndikatet.eu are needed
  because mail is sent as `@gmail.com` (Google's servers are authorised for it).
- Supabase shows a warning that the provider is "designed for personal rather
  than transactional email." **This is expected and safe to ignore** at family
  scale (~6 recipients). Gmail's limit is ~500 emails/day — far above any need.
- First invite may land in Spam / the Promotions tab; recipients should mark
  "not spam" once.
- Future upgrade path (only if a branded `@syndikatet.eu` sender is ever wanted):
  a transactional provider like **Resend** (free 3000/month) with DNS records on
  syndikatet.eu. Not currently used.

**First login** → `must_change_password: true` in user metadata →
`bootApp` shows the Norwegian change-password screen ("Velg ditt eget passord").
No password strength rules in the UI; Supabase's 6-char minimum is handled
invisibly by `padPassword`. After setting a new password `must_change_password`
is cleared and the player lands in the app.

### Prediction save (`savePred`)
- Collects all `data-mid` values from `#pred-content [data-side="h"]` inputs
- For each match with empty inputs: deletes existing prediction from DB
- For each match with non-empty inputs: upserts with `onConflict: 'player_id,match_id'`
- Then re-fetches all predictions for the player to update global `preds`
- `doAutosave()` is `async` — auto-saves 2 seconds after any input change
- `data-mid` on prediction inputs is `m.id` (matches.id integer, e.g. 73), NOT match_number

### Scoring
- `calcScore(ph, pa, ah, aa, round)`: returns points for a prediction.
  - Exact score → `gs_exact` (group) or `ko_exact` (knockout) points (default 5)
  - Correct result (W/D/L) → `gs_result` or `ko_result` points (default 2)
  - Wrong → 0
- Bonus points for correctly predicting which teams reach each knockout round
  are tracked separately via the `bonus_r*` settings keys.

### Bonus questions (side quiz)
- `bonus_questions` (id, sort_order, question, type ∈ yesno/choice/number/text,
  options jsonb, **correct_answer text**) and `bonus_answers` (player_id,
  question_id, answer, points). RLS: public read both; admin writes both;
  players write their own answers. Unique key `(player_id, question_id)`.
- **Admin enters the correct answers on Enter Results → "🎯 Bonus" tab**
  (`renderAdminBonus` / `saveBonusResults`; the "Bonus" admin tab is appended in
  `buildTabs`, and `adminRound==='bonus'` routes both `renderAdmin` and
  `saveResults`). Saving stores `bonus_questions.correct_answer` and
  **auto-scores**: each `bonus_answers.points` becomes `settings.bonus_q_pts` if
  the answer matches (case-insensitive trim; numeric compare for number type),
  else 0. Questions left blank are skipped (existing points untouched), so manual
  per-player overrides on the Bonus page still work.
- Leaderboard reads `bonus_answers.points` directly (the `Extra` column).

### Date/time display (all in Europe/Oslo / CEST)
- `formatKickoff(m)`: returns full datetime string, e.g. "11.06 21:00"
- `formatKickoffShort(m)`: returns compact date+time, e.g. "11.06 21:00" (no year)
- Both fall back gracefully if `kickoff_utc` is null.

### Prediction freeze
- `isMatchFrozen(m)`: returns true if match has a score already, OR if it's within 10 minutes of kickoff_utc.
- Frozen inputs render with `opacity:.45; pointer-events:none` and a 🔒 icon.
- `startCountdownTimer()`: runs a 1-second interval showing time until next freeze; displayed in `#pred-countdown` bar on the predictions page.

### Rounds and bracket
Rounds in order: group → R32 → R16 → QF → SF → final / bronze

Source of truth: https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage

#### R32 bracket (M73–M88) — `R32_BRACKET` in code
Slots: `W_X` = Winner Group X, `R_X` = Runner-up Group X, `T3` = best 3rd-place (8 slots)

| Match | Home          | Away         |
|-------|---------------|--------------|
| M73   | Runner-up A   | Runner-up B  |
| M74   | Winner E      | T3           |
| M75   | Winner F      | Runner-up C  |
| M76   | Winner C      | Runner-up F  |
| M77   | Winner I      | T3           |
| M78   | Runner-up E   | Runner-up I  |
| M79   | Winner A      | T3           |
| M80   | Winner L      | T3           |
| M81   | Winner D      | T3           |
| M82   | Winner G      | T3           |
| M83   | Runner-up K   | Runner-up L  |
| M84   | Winner H      | Runner-up J  |
| M85   | Winner B      | T3           |
| M86   | Winner J      | Runner-up H  |
| M87   | Winner K      | T3           |
| M88   | Runner-up D   | Runner-up G  |

T3 slots are in matches: M74, M77, M79, M80, M81, M82, M85, M87 (8 slots for 8 best 3rd-place teams).

**Third-place matrix:** `THIRD_PLACE_MAP` is a compact encoded lookup table with 495 entries
(one per combination of which 8 of the 12 groups provide a 3rd-place qualifier).
Key = sorted 8-letter group string (e.g. "ABCDEFGH"), value = 8-char assignment string
where each character at position p gives which group's 3rd-place team goes to the T3 slot
in match `T3_POS[match]` (T3_POS: M74→pos3, M77→pos5, M79→pos0, M80→pos7,
M81→pos2, M82→pos4, M85→pos1, M87→pos6).

R32 slots are **certain vs. provisional**:
- **Certain** (a team has mathematically clinched that exact slot): the actual
  team name is **written to the DB** by `resolveCertainR32()` (runs on admin
  login and on every group-result save). `groupClinchInfo` returns
  `certainWinnerTeam` / `certainRunnerUpTeam` (guaranteed 1st / guaranteed 2nd,
  using points + head-to-head; completed groups use the actual standings); best-8
  thirds become certain only once the whole group stage is complete. Uncertain
  slots are reset to their bracket **label** (`R32_LABELS`: `1E`, `2A`,
  `3ABCDF`), so a corrected result reverts a slot to its label.
- **Provisional** (still a label): `r32Projection()` derives the current
  projected team from live `calcStandings()` and `projSmall(m, side)` shows it in
  small grey text **next to** the label — in My Predictions, View Predictions,
  Enter Results, and the Settings KO editor. `projSmall` only annotates cells
  whose value is still a digit-prefixed label. `_r32proj` caches per render
  (reset at the top of renderPred / renderViewPredInner / renderAdmin /
  renderSettings).

#### R16 (M89–M96) — `KO_BRACKET` in code
| Match | Home       | Away       |
|-------|------------|------------|
| M89   | Winner M74 | Winner M77 |
| M90   | Winner M73 | Winner M75 |
| M91   | Winner M76 | Winner M78 |
| M92   | Winner M79 | Winner M80 |
| M93   | Winner M83 | Winner M84 |
| M94   | Winner M81 | Winner M82 |
| M95   | Winner M86 | Winner M88 |
| M96   | Winner M85 | Winner M87 |

#### QF (M97–M100)
| Match | Home       | Away       |
|-------|------------|------------|
| M97   | Winner M89 | Winner M90 |
| M98   | Winner M93 | Winner M94 |
| M99   | Winner M91 | Winner M92 |
| M100  | Winner M95 | Winner M96 |

#### SF, Bronze, Final
| Match | Home        | Away        |
|-------|-------------|-------------|
| M101  | Winner M97  | Winner M98  |
| M102  | Winner M99  | Winner M100 |
| M103  | Loser M101  | Loser M102  |
| M104  | Winner M101 | Winner M102 |

**Note:** The THIRD_PLACE_MAP (495 rows) was pre-populated in the code and needs
verification against the Wikipedia matrix table. Do not regenerate it without
checking against the source — it is complex and error-prone.

### Bot players
Two fixed bot players exist in the `players` table with no corresponding `auth.users` entries:
| Name       | UUID                                   |
|------------|----------------------------------------|
| RandomBot  | `00000000-0000-0000-0000-000000000001` |
| Claude     | `00000000-0000-0000-0000-000000000002` |

Constants in code: `RANDOMBOT_ID`, `CLAUDEBOT_ID`.

Admin controls bots from the **My Predictions** page via three player-selector tabs
("My Predictions | RandomBot | Claude") shown above the round tabs. When a bot tab
is selected:
- `predPlayerId` is set to the bot's UUID
- `preds` is reloaded for that player
- Bot predictions DO freeze with the per-round freeze, same as players
  (`isMatchFrozen` no longer special-cases bots). `savePred` also skips any
  frozen match, so Random/Ask Claude cannot overwrite a bot result after the
  round locks. Admin must enter bot predictions before the round freezes.
- Round-lock (knockout round not yet unlocked) is still bypassed in `renderPred`
  for bots, so admin can pre-fill bot knockout predictions before those rounds
  open — that is independent of the time-based freeze.
- `savePred` saves with `predPlayerId` instead of `player.id`

**RandomBot:** "Random" button fills random scores (0–3) for the current round.

**Claude bot:** A purple toolbar appears at the top with:
- "Ask Claude All" button — fetches predictions for all unpredicted matches in the round
- "Ask" button per match row

Claude predictions call the **`claude-predict` Supabase Edge Function** (not the
Anthropic API directly — direct browser calls fail CORS on Safari). The function:
- Reads the API key from `settings.text_value` where `key = 'anthropic_key'`
- Calls `claude-haiku-4-5-20251001` with a match prediction prompt
- Returns `{"home": N, "away": N, "et_winner": "H"|"A"|null}`
- Is deployed with `verify_jwt: false`

### Player management
`removePlayer(btn)` deletes predictions and the players row. The `on_player_delete`
DB trigger then automatically deletes the auth.users entry, so the tables stay in
sync. Removing and re-inviting the same email via the UI always works cleanly.

**Note:** Bot players have no auth.users entries — do NOT remove them via the UI
(the trigger would try to delete a non-existent auth user, which is harmless but
the bots would then be gone from the leaderboard). If accidentally removed, re-insert
them directly via SQL with their fixed UUIDs.

---

## Tournament structure
- 48 teams, 12 groups (A–L) of 4 teams each
- 72 group stage matches (M1–M72)
- Group stage: June 11 – June 26, 2026
- R32: 16 matches (M73–M88), June 28 – July 3
- R16: 8 matches (M89–M96), July 4–7
- QF: 4 matches (M97–M100), July 9–11
- SF: 2 matches (M101–M102), July 14–15
- Bronze final: M103, July 18
- Final: M104, July 19

Top 2 from each group + 8 best third-place teams → 32 teams in R32.

## Keepalive ping
A silent Supabase keepalive ping is implemented in index.html.
Fires once every 4 days when the app is opened in a browser.
Uses localStorage key: `wc2026_keepalive`
Queries the matches table for a single row.
Purpose: prevent Supabase free tier from pausing during
inactive periods before the tournament.

## Domain
- Primary URL: https://vm2026.syndikatet.eu
- DNS: CNAME vm2026 → lstol.github.io
- HTTPS certificate: issued by GitHub via Let's Encrypt
- Supabase allowed redirect URL: https://vm2026.syndikatet.eu

## Deployment
- git push to main branch → GitHub Pages auto-deploys
- No manual upload needed when using Claude Code
- In Claude Code just say: "commit and push to GitHub"

## Workflow: claude.ai → Claude Code handoffs

When claude.ai makes changes (edge functions, index.html, SQL, config), it will
end the session with a handoff block. Your job is to apply those changes locally
and push to GitHub.

### Handoff format
claude.ai will produce a message like:

--- HANDOFF FOR CLAUDE CODE ---
Changes made this session:
- [file or system]: [what changed]

Actions needed:
1. [specific file to create/update with content, or action to take]
2. git commit -m "[suggested commit message]"
3. git push
--- END HANDOFF ---

Apply each change exactly as described, then commit and push.
If a file is provided with full content, write it verbatim.
If an edge function was deployed to Supabase, write the code to
supabase/functions/<name>/index.ts.
Always confirm with: "Handoff applied. Committed: [commit hash]"
