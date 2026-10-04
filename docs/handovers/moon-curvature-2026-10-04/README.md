# Moon camera and curvature handover

Start here when working on branch `fixCamera`. This folder contains the investigation, original user screenshot, all comparison pictures, measurements, logs and diagnostic scripts. It is self-contained in a normal repository checkout.

- [Full handover](HANDOVER.md): findings, uncertainty, strategic proposal, source pointers and reproduction instructions.
- [Original user screenshot](original/user-moon-screenshot.png): the exact 3456 × 2166 attachment.
- [Controlled lens comparison](evidence/lens-comparison.png): the same scene and camera under two projections.
- [Real flight comparison](evidence/approach/sheet.jpg): the existing optional lens ramp during approach.
- [Evidence manifest](manifest.json): file sizes and SHA-256 hashes.

![Original user screenshot](original/user-moon-screenshot.png)

![Controlled lens comparison](evidence/lens-comparison.png)

The measured outline is consistent with a sphere. The appearance involves projection, camera distance relative to spacecraft scale, and coarse shading relief. The user asked for an extensive root-cause investigation and a strategic approach comparable to a AAA studio's work. No camera or terrain repair has been implemented or selected.

This branch starts at the investigation's tested source revision, `e083aef86f356eb9eb3cd911669278a3d9e3b56f`. Its new commit publishes the handover rather than changing the application.

## Cloud agent starting task

Read `HANDOVER.md`, inspect the original photo and comparisons, then inspect the camera, spacecraft-scale and surface code linked in the handover. Reconfirm which revision you are working on. Develop concrete camera-and-scale prototypes and a representative lunar-region test plan from the strategic proposal. Preserve physical geometry and unrestricted viewing. Distinguish measurements from hypotheses, and define visual and performance acceptance gates before broad changes. Follow the user's next instruction on whether to implement a prototype or stop at a plan.

## Verify the bundle

From the repository root:

```sh
python3 docs/handovers/moon-curvature-2026-10-04/verify.py
```

The handover and evidence can be read without installing the application or running a browser. Reproduction scripts need the dependencies and browser setup described in `HANDOVER.md`. Historical Mac paths in raw records or exact original scripts are provenance; the portable copies and relative links do not depend on those paths.
