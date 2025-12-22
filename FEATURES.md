# NFL Picks Dashboard - Improvement Roadmap

Based on comprehensive UX audit performed December 2024.

**Overall Score: 6.8/10** - Functional but needs polish

---

## Critical Priority - COMPLETED

All critical accessibility violations have been fixed.

---

## High Priority (Next Sprint)

### Onboarding & Discoverability

5. **Add First-Visit Onboarding**
   - Brief overlay explaining key features
   - Show only once, store in localStorage
   - Explain: How to make picks, what tabs mean, keyboard shortcuts
   - Effort: Medium
   - Status: Completed (December 2024)

6. **Add Info Tooltips for Terminology**
   - "What is Blazin' 5?" info icon
   - "Line Picks vs Straight Up" explanation
   - Hover or click to reveal
   - Effort: Low
   - Status: Pending

7. **Improve Loading Experience**
   - Add skeleton screens during data fetch
   - Show loading progress indicator
   - Reduce perceived 10-second wait time
   - Effort: Medium
   - Status: Pending

### Mobile Experience

8. **Reposition Mobile Floating Buttons**
   - Back-to-top, keyboard toggle, progress bar overlap
   - Stack vertically or show only one at a time
   - Effort: Low
   - Status: Pending

9. **Add Swipe Gestures for Week Navigation**
   - Swipe left/right to change weeks on mobile
   - More intuitive than arrow buttons
   - Effort: Medium
   - Status: Pending

### Error Handling

10. **Improve Error Messages**
    - Replace generic "Unable to load picks data"
    - Add specific messages: "Check your internet connection"
    - Suggest recovery actions
    - Effort: Medium
    - Status: Pending

11. **Add Offline Detection**
    - Detect when user is offline
    - Show cached data with "Offline" indicator
    - Effort: Medium
    - Status: Pending

---

## Medium Priority (Roadmap)

### Accessibility Continued

12. **Add Page Landmarks**
    - Add `<main>`, `<nav>`, `<aside>` tags
    - Include skip-to-content link
    - Effort: Low
    - Status: Pending

13. **Add Scope to Table Headers**
    - Scoring summary table missing proper header scopes
    - Effort: Low
    - Status: Pending

14. **Add ARIA Live Regions for Score Updates**
    - Announce live score changes to screen readers
    - Effort: Medium
    - Status: Pending

### Features

15. **Add Search/Filter Games**
    - Search by team name
    - Filter by game status (upcoming, in progress, final)
    - Effort: Medium
    - Status: Pending

16. **Add Picker Comparison Mode**
    - Compare two pickers side-by-side
    - Show head-to-head record
    - Effort: High
    - Status: Pending

17. **Add Notes to Picks**
    - Optional text field for pick reasoning
    - "Injury to key player", "Home field advantage"
    - Effort: Medium
    - Status: Pending

18. **Implement PWA/Offline Support**
    - Service worker for caching
    - Works offline with cached data
    - Installable on mobile
    - Effort: High
    - Status: Pending

### Performance

19. **Lazy Load Charts**
    - Only render charts when section is expanded
    - Destroy chart instances when collapsed
    - Effort: Medium
    - Status: Pending

20. **Reduce Live Score Polling on Mobile**
    - Increase interval from 30s to 60s on mobile
    - Reduce battery drain
    - Effort: Low
    - Status: Pending

---

## Low Priority (Nice-to-Have)

### Delight Factors

21. **Add Celebration Animation**
    - Confetti when all picks are complete (100%)
    - Effort: Low
    - Status: Pending

22. **Add Streak Badges**
    - Show "Hot Hand" badge after 3-game win streak
    - Visual indicator next to picker names
    - Effort: Medium
    - Status: Pending

23. **Add Social Sharing**
    - Share picks as image for social media
    - Generate shareable summary card
    - Effort: High
    - Status: Pending

24. **Add Seasonal Themes**
    - Playoff theme during playoffs
    - Super Bowl special styling
    - Effort: Low
    - Status: Pending

### UX Polish

25. **Scroll to Top on Week Change**
    - Changing weeks should scroll page to top
    - Prevent disorientation
    - Effort: Low
    - Status: Pending

26. **Add Undo for Destructive Actions**
    - Undo clear picks within 5 seconds
    - Effort: Medium
    - Status: Pending

27. **Show Last Updated Timestamp**
    - "Scores updated at 3:45 PM"
    - Indicates live data freshness
    - Effort: Low
    - Status: Pending

28. **Add Copy Confirmation Animation**
    - Highlight animation when "Copy Picks" succeeds
    - More visible than toast alone
    - Effort: Low
    - Status: Pending

---

## Technical Debt

### Code Quality Issues Affecting UX

29. **Add Team Logo Fallbacks**
    - ESPN CDN occasionally fails
    - Show team abbreviation or color swatch as fallback
    - Effort: Low
    - Status: Pending

30. **Validate Parsed CSV Data**
    - Brittle parsing depends on exact column positions
    - Add validation and error reporting
    - Effort: Medium
    - Status: Pending

31. **Fix Chart.js Memory Leaks**
    - Chart instances need explicit destroy on re-render
    - Effort: Low
    - Status: Pending

32. **Consider TypeScript Migration**
    - Prevent type-related bugs
    - Improve maintainability
    - Effort: High
    - Status: Pending

---

## Completed Features

### December 2024

**Accessibility Fixes (Critical)**
- Alt Text on Team Logos - All logos now have descriptive alt text ("Chiefs logo")
- Color Contrast Fix - `--text-light` updated to WCAG AA compliant values
- Escape Key for Modals - Confirm dialogs can now be closed with Escape key
- Aria Labels on Buttons - All icon-only buttons now have screen reader labels

**Onboarding & Discoverability**
- First-Visit Onboarding - Welcome overlay explaining picks, Blazin' 5, tabs, and keyboard shortcuts

**Features**
- Collapsible Sections - Click headers to collapse/expand
- Pull to Refresh - Mobile gesture for live scores
- Remember Selected Picker - Persists in localStorage
- Live Scoring Summary - Real-time ESPN scores
- Blazin' 5 Selector - Star button with 5-pick limit
- Sticky Tabs and Back to Top - Fixed navigation

---

## Audit Summary

### Strengths
- Professional visual design (9/10)
- Good responsive layouts
- Rich feature set
- Thoughtful details (dark mode, keyboard shortcuts)
- Accessibility basics now covered (7/10) - contrast, alt text, keyboard nav fixed

### Remaining Weaknesses
- Discoverability (6/10) - some features still unexplained (info tooltips pending)
- Error handling (5/10) - generic messages, no recovery
- Onboarding now addressed with welcome overlay

### Key Insight
Works great for existing users who know the context. Confusing for newcomers who won't know what "Blazin' 5" means or how to make picks.

---

Last updated: December 22, 2024
