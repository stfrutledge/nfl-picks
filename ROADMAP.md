# NFL Picks Dashboard - Enhancement Roadmap

*Interview completed: January 4, 2026*

## Vision

Build an impressive, polished site that works on multiple levels:
- Personal satisfaction with a premium tool
- Enhance the shared experience for the pick group
- Potentially shareable publicly

**Timeline:** Targeting 2026 NFL season. Current season (ending now) is testing ground.

---

## Core Direction

### Visual Storytelling
- Interactive drill-down via **inline expansion** (not modals/popups)
- Sports broadcast feel inspired by **NFL app** aesthetic
- **Minimal team color usage** - just logos, keep UI colors consistent
- **Truly responsive** - equal importance across desktop, mobile, tablet

### Depth of Insight
- Descriptive stats (polished presentation of what happened)
- Pattern recognition ("You're 2-8 on Monday games")
- Predictive hints ("Based on history, you typically pick X here")
- External data: Only if reliable free sources exist (skip public betting % if unreliable)

### Social/Competitive
- **Friendly ribbing tone** - light-hearted, highlight funny losses
- Bad beat highlights (auto-surface last-second losses)
- Weekly roasts (auto-generated "Worst Pick of the Week")

---

## Priority Features (in order)

### 1. Pattern Insights (TOP PRIORITY)
- Surface interesting stats about each picker
- Show **everyone's data** (not personalized to viewer)
- **All granularity levels:**
  - Per-person tendencies ("Steve picks home underdogs 70%")
  - Situational splits ("Dimmer is 2-7 in primetime")
  - Team-specific ("Alexa has never correctly picked Cowboys")
- Display **everywhere relevant** - sprinkled throughout UI where they apply

### 2. Live Pick Tracking
- **Overlay on current display** (not a separate gameday view)
- Show pick margins updating during games
- Example: "Steve needs Cowboys +3, currently Cowboys -2 with 4:00 left"
- Active tracking experience for Sundays

### 3. Hall of Shame
- **Persistent hall of shame** - running list of worst moments, always visible
- **End of week summary** - weekly compilation after Monday night
- **Fully automated** - algorithm picks worst pick, generates roast text
- Bad beat highlights when someone loses by last-second FG, etc.

### 4. Visual Overhaul
- NFL app aesthetic (bold, clean, team logos)
- Sports broadcast energy
- Enhanced charts with inline expansion on click

---

## UX Decisions

| Decision | Choice |
|----------|--------|
| Navigation | Keep tabs, enhance existing structure |
| Insights placement | Everywhere relevant (contextual) |
| Drill-down interaction | Inline expansion below/beside charts |
| Personalization | Show everyone's data equally |
| Team colors | Minimal - logos only, consistent UI colors |
| Roast timing | Persistent + weekly summary |

---

## Technical Constraints

- **Architecture:** Keep it simple - localStorage + Google Sheets sync
- **APIs:** Free only
- **Public betting %:** Skip unless reliable free source found
- **No backend:** Stay client-side

---

## Current State

The site is functional and achieves parity with the Google Sheet. Features already built:
- Make Picks tab with live scores
- Performance & Insights with charts
- Blazin' 5 tracking
- Historical data (weeks 1-15)
- ESPN API for schedules
- Odds API for spreads
- Google Sheets sync
- Collapsible sections
- Pull-to-refresh on mobile

---

## Next Steps

1. Design pattern insights system (what patterns to detect, how to surface them)
2. Implement pattern detection engine
3. Add contextual insight display throughout UI
4. Build live pick tracking overlay
5. Create hall of shame with automated roasts
6. Visual refresh toward NFL app aesthetic
