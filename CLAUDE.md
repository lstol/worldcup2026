# WorldCup 2026 - Family Prediction App

## Project overview
Single `index.html` file, vanilla JavaScript, no frameworks.
Hosted on GitHub Pages at lstol.github.io/worldcup2026.
Supabase backend for data persistence.

## Infrastructure
- Supabase project URL: agreoglnwnesdekjbacu.supabase.co
- GitHub repo: github.com/lstol/worldcup2026
- Admin user: lasse.stoltenberg@gmail.com

## Architecture
- Single index.html contains all HTML, CSS and JavaScript
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
- Validate JS syntax before every commit
- Prefer complete, thorough changes over small incremental patches
- Commit regularly with descriptive messages
