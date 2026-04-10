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

**Important:** `players.id` must equal `auth.users.id` for RLS to work correctly.
New players created via Settings → Add Player will have this set correctly.
Some legacy players (Arne, lstol@equinor.com) have a mismatch — their
`players.id` was set manually and differs from their `auth.users.id`.

**Invariant enforced by trigger:** A database trigger (`on_player_delete`) fires
`AFTER DELETE ON players` and automatically deletes the corresponding `auth.users`
row via `public.delete_auth_user_on_player_delete()` (SECURITY DEFINER). This
keeps `players` and `auth.users` in sync — removing a player via the UI fully
cleans up both tables, so the same email can be re-invited cleanly.

### `settings`
Key/value table. Known keys:
| Key            | Default | Meaning                                     |
|----------------|---------|---------------------------------------------|
| gs_exact       | 5       | Points for exact score in group stage       |
| gs_result      | 2       | Points for correct result in group stage    |
| ko_exact       | 5       | Points for exact score in knockout rounds   |
| ko_result      | 2       | Points for correct result in knockout rounds|
| bonus_r32      | -       | Bonus pts for predicting a team reaching R32 |
| bonus_r16      | -       | Bonus pts for R16                           |
| bonus_qf       | -       | Bonus pts for QF                            |
| bonus_sf       | -       | Bonus pts for SF                            |
| bonus_final    | -       | Bonus pts for Final                         |
| preds_visible  | 0       | Whether all players can see each other's predictions |

---

## RLS policies

### `players` table
- `read_all`: USING (true) — any authenticated user can read all rows
- `admin_insert`: WITH CHECK: EXISTS (SELECT 1 FROM players WHERE id = auth.uid() AND is_admin = true)
- `admin_update`: USING: same admin check
- `admin_delete`: USING: same admin check
- `self_update_name`: USING (id = auth.uid()) WITH CHECK (id = auth.uid()) — players can update their own row

### `predictions` table
- `public read predictions`: USING (true) — all authenticated users can read
- `players insert own`: WITH CHECK (player_id = auth.uid()) — players can insert their own
- `players update own`: USING (player_id = auth.uid()) — players can update their own
- `players delete own`: USING (player_id = auth.uid()) — players can delete their own
- `Admin can delete any predictions`: USING (admin check) — admin can delete any row

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

### Player invite flow (Settings → Add Player)
`sendInvite(btn)` steps:
1. Save the admin's current session tokens (`getSession()`).
2. Call `sb.auth.signUp()` with the player's email and `padPassword(name)`.
   - If "already registered" error AND this is a Re-invite (row has `data-pid`):
     treat as soft error and continue — just update name in players row.
   - If "already registered" error AND this is a new Add Player row (no `data-pid`):
     abort with an error. The auth account exists but we cannot recover its UUID
     from the client. This prevents creating a players row with a mismatched UUID
     (which would silently break login). The right fix is to Remove the player
     first (which now also deletes the auth account via the DB trigger), then
     re-add them.
   - Otherwise abort on auth errors.
3. Restore admin session via `setSession()` — critical because `signUp()` with
   autoconfirm enabled auto-signs-in the new user, silently replacing the admin
   session and causing the next DB write to fail RLS.
4. Upsert into `players` with `{ id: authUUID, name, email, is_admin: false }`.
   Using the auth UUID ensures `players.id = auth.uid()` from day one.
5. Call `sb.auth.resetPasswordForEmail(email)` to trigger the welcome email
   (Supabase sends no email on signUp when autoconfirm is on; this is the
   delivery mechanism).

**Initial password** = player's name as entered by admin (e.g. "Alma"),
padded with underscores if under 6 chars. Players are told their initial
password in the welcome email and never see the padding.

**Welcome email template** is configured in Supabase dashboard under
Authentication → Email Templates → Reset Password. Template uses:
- `{{ .Email }}` — player's email address
- `{{ .Data.name }}` — player's name (set in signUp user metadata)
- Plain link to `https://vm2026.syndikatet.eu` (no magic link / recovery token)
- No `{{ .ConfirmationURL }}` — players simply go to the login page directly.

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

**R32 bracket** (matches 73–88) is stored in `R32_BRACKET` object mapping
match_number → { h: slot, a: slot } where slots are:
- `W_X` = Winner of Group X
- `R_X` = Runner-up of Group X
- `T3` = Best third-place team (determined by `THIRD_PLACE_MAP`)

`autoPopulateR32()` (called when admin saves group stage results) reads
group standings, resolves bracket slots, and updates match home_team/away_team
for R32 matches automatically.

`THIRD_PLACE_MAP` is a large lookup table mapping which 8 of the 12 groups had
third-place qualifiers (encoded as a string key like "ABCDEFGH") to an ordered
array of which match slot each qualifier fills.

### Player management
`removePlayer(btn)` deletes predictions and the players row. The `on_player_delete`
DB trigger then automatically deletes the auth.users entry, so the tables stay in
sync. Removing and re-inviting the same email via the UI always works cleanly.

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
