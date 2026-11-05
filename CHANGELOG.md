# Changelog

## 1.0.7

- **Powered, at a glance.** The sentence over the drawing is now one line: an icon for each source feeding the house, in its colour and in the drawing's order (the sun, the battery, a power plant for the grid), then "Powered". The full sentence is its tooltip and its label for screen readers, and old data greys the icons.
- **Panels lit by what they make.** The roof carries eight panels, each a grid of 48 by 48 pixels in the roof's plane. The share lit is the array's output over the most it makes, scattered at random: none at night, all at its best. A pixel lit at a lower power stays lit as the power rises.
- **`array_kw`.** The most the array makes, which sets when every pixel is lit; its best clear-day output is a good figure. Without it the card uses the best five minutes of the last 30 days.
- **Closer on the junction.** The drawing is framed from the panels to the pole, so the house is larger and the junction sits near the middle. Solar runs off the top row of panels and drops straight into the junction, the battery's line runs along the foot of the wall to the towers, and the house's line ends in a plain box on the long wall.
- **Solid and softly lit.** No outlines: the house is drawn in planes under a high sun at the upper right, the roof lightest and the long wall darkest, with short shadows falling to the lower left and each panel standing off the roof. Lines carrying nothing show faintly against the house.
- **Battery towers rooted at the right.** Slimmer cabinets tinted with the battery's colour hold their charge. The rightmost stays put and each added pack pushes the row left, so with fewer packs the battery's line runs farther.
- **One grid for the figures.** Solar, Grid, House and Battery each sit flush against an upright, solid lead, in two rows; dashes are left to the lines that carry power. Battery's name sits over its state, then its figure.
- On a phone, the drawing takes the height its width gives it.

## 1.0.1

- **One lane per source.** A line that carries power from more than one source now carries a thin lane for each, side by side in its own colour: solar and the battery feeding the house together show as amber beside green, where before the battery's colour covered the solar it ran with.
- **Finer beads.** The beads are thinner, with shorter gaps, so each lane reads as one continuous line.

## 1.0.0

The first release.

- **The battery first.** The state of charge in a ring that carries the backup reserve, with what it means under it: when the battery empties or fills at the present rate, or that what is left is kept for outages.
- **The home, drawn.** A line in words over a drawing of the home: the panels, the battery towers filling with the charge, and the circuit through the X1. Each line that carries power takes the colour of the energy on it, with beads drifting the way the power goes.
- **Day, week, month and year.** Anker's own totals as six headline figures, with the change against the previous period; a chart of what ran the house and what was stored or sold; the battery's charge through the day, or each day's self-sufficiency; and the period's self-sufficiency, solar kept and saving, priced at your tariff if you give one.
- **Read any moment.** Hover, drag a finger across a chart, or use the arrow keys, and download any period as CSV.
- **Fits a laptop.** One screen without scrolling, in light and dark, and a phone layout that stacks the same parts.
