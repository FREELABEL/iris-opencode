---
category: Content & Media
level: beginner
tags: [review-studio, video, notes, timecode, feedback, remotion, re-render, replace, cdn]
duration_min: 4
---
# How to: Leave feedback at a moment in a video, and replace a render

## Time-coded notes

In **Review Studio**, a note on a video is pinned to where the playhead is. Click its `0:42` chip
to jump there. From the CLI:

```bash
iris remotion note 9123 "logo too small" -t 0:42
iris remotion notes 9123                  # in playback order
iris remotion notes 9123 --revision       # open notes as instructions for a re-render
```

## Replace a render, keep the link

```bash
iris remotion replace 9123 ./final-v2.mp4
```

The file is swapped behind the **same URL**, so pages and embeds that already use it show the new
version. Earlier versions are kept. A video can only be replaced by a video.
