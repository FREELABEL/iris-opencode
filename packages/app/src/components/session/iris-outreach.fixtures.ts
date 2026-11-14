/**
 * RECORDED, NOT TYPED (#193487). Real answers from this branch's engine, signed in to production,
 * 2026-11-14 — the same fl-api data the CLI reads:
 *
 *   iris serve (this branch) → curl /iris/outreach/campaigns            (= iris som campaign list --json + eligible pool totals)
 *   iris serve (this branch) → curl /iris/outreach/campaigns/1/audience (report identical to: iris som preflight courses --json)
 *   iris serve (this branch) → curl /iris/outreach/campaigns/2/audience (report identical to: iris som preflight creators --json)
 *   iris serve (this branch) → curl /iris/outreach/strategies           (= iris reachr list <bloq> --json, per board)
 *   iris serve (this branch) → curl "/iris/comms?days=14"  and  /iris/reachr/batches
 *
 * Trimmed for a public repo, nothing invented: strategies limited to the ones a campaign runs, each
 * step's ai_prompt cut to 80 characters; conversations keep their flags, channels and timestamps but
 * lead names, ids and message text are replaced. /iris/reachr/batches answered an empty list that day.
 * CAMPAIGNS was re-recorded after members / mine_ids were added: fl-api sent no members yet, and
 * /api/v1/som/campaigns/mine answered 404 (#193486 not deployed), hence members: null, mine_ids: null.
 */
export const CAMPAIGNS = {
 "measured": true,
 "data": {
  "campaigns": [
   {
    "id": 7,
    "name": "atxbeauty",
    "label": "ATX Beauty Outreach",
    "bloq_id": 283,
    "strategy_template_id": 26,
    "strategy_name": "Beauty & Wellness Outreach | V1",
    "ig_account": "atxbeautylab.lisa",
    "tw_account": "freelabelnet",
    "active": false,
    "is_live": false,
    "geo_tag": "austin",
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 0,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 0,
    "fits": null
   },
   {
    "id": 3,
    "name": "beatbox",
    "label": "DJ Outreach",
    "bloq_id": 224,
    "strategy_template_id": 27,
    "strategy_name": "DJ Outreach | V2",
    "ig_account": "thebeatbox__",
    "tw_account": "freelabelnet",
    "active": false,
    "is_live": false,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 5,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 0.1,
    "fits": null
   },
   {
    "id": 1,
    "name": "courses",
    "label": "AI Course Outreach",
    "bloq_id": 38,
    "strategy_template_id": 58,
    "strategy_name": "Roadmap Commenters | V1",
    "ig_account": "heyiris.io",
    "tw_account": "freelabelnet",
    "active": true,
    "is_live": true,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 6050,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 151.3,
    "fits": null
   },
   {
    "id": 2,
    "name": "creators",
    "label": "Creator Outreach",
    "bloq_id": 80,
    "strategy_template_id": 59,
    "strategy_name": "IRIS for Creators | V1",
    "ig_account": "thediscoverpage_",
    "tw_account": "freelabelnet",
    "active": true,
    "is_live": true,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 4185,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 104.6,
    "fits": null
   },
   {
    "id": 6,
    "name": "freelabelnet",
    "label": "FFAT Artists (Austin)",
    "bloq_id": 355,
    "strategy_template_id": 35,
    "strategy_name": "Artist Outreach | FFAT V1",
    "ig_account": "freelabelnet",
    "tw_account": "freelabelnet",
    "active": false,
    "is_live": false,
    "geo_tag": "austin",
    "starts_at": null,
    "ends_at": "2026-06-06T00:00:00+00:00",
    "audience_note": null,
    "members": null,
    "eligible": 0,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 0,
    "fits": null
   },
   {
    "id": 8,
    "name": "gooddeals",
    "label": "Good Deals Outreach",
    "bloq_id": 302,
    "strategy_template_id": 31,
    "strategy_name": "LinkedIn Founder Outreach | V1",
    "ig_account": null,
    "tw_account": null,
    "active": false,
    "is_live": false,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 0,
    "daily_cap": 25,
    "cap_source": "default",
    "days_of_supply": 0,
    "fits": null
   },
   {
    "id": 10,
    "name": "interviews-builders",
    "label": "AI Founder Interview Series",
    "bloq_id": 38,
    "strategy_template_id": 45,
    "strategy_name": "Founder Interview Series | V1",
    "ig_account": "heyiris.io",
    "tw_account": null,
    "active": false,
    "is_live": false,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 6050,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 151.3,
    "fits": null
   },
   {
    "id": 11,
    "name": "interviews-creators",
    "label": "Creator Feature Series",
    "bloq_id": 80,
    "strategy_template_id": 46,
    "strategy_name": "Creator Feature Series | V1",
    "ig_account": "thediscoverpage_",
    "tw_account": null,
    "active": false,
    "is_live": false,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 4185,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 104.6,
    "fits": null
   },
   {
    "id": 4,
    "name": "mayo",
    "label": "Mayo Outreach",
    "bloq_id": 176,
    "strategy_template_id": 21,
    "strategy_name": "Mayo Outreach | V2",
    "ig_account": "hourdemayo",
    "tw_account": "freelabelnet",
    "active": false,
    "is_live": false,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 0,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 0,
    "fits": null
   },
   {
    "id": 5,
    "name": "venues",
    "label": "Venue Partnership",
    "bloq_id": 292,
    "strategy_template_id": 28,
    "strategy_name": "Venue Partnership | V1",
    "ig_account": "freelabelnet",
    "tw_account": "freelabelnet",
    "active": false,
    "is_live": false,
    "geo_tag": null,
    "starts_at": null,
    "ends_at": null,
    "audience_note": null,
    "members": null,
    "eligible": 0,
    "daily_cap": 40,
    "cap_source": "default",
    "days_of_supply": 0,
    "fits": null
   }
  ],
  "mine_ids": null
 }
}

export const AUDIENCE_COURSES = {
 "measured": true,
 "reason": null,
 "data": {
  "campaign": {
   "id": 1,
   "name": "courses",
   "label": "AI Course Outreach",
   "bloq_id": 38,
   "strategy_template_id": 58,
   "strategy_name": "Roadmap Commenters | V1",
   "ig_account": "heyiris.io",
   "tw_account": "freelabelnet",
   "active": true,
   "is_live": true,
   "geo_tag": null,
   "starts_at": null,
   "ends_at": null,
   "audience_note": null,
   "eligible": 6050,
   "daily_cap": 40,
   "cap_source": "default",
   "days_of_supply": 151.3,
   "fits": 226
  },
  "report": {
   "campaign": "courses",
   "active": true,
   "board": 38,
   "strategy": "Roadmap Commenters | V1",
   "strategy_found": true,
   "eligible": 6050,
   "scanned": 6050,
   "daily_cap": 40,
   "days_of_supply": 151.3,
   "supply": "ok",
   "audience": "mismatch",
   "audience_reason": "strategy is written for post /p/De9Uw8Ilhne or \"roadmap\" commenters; 226 of 6050 eligible leads scanned (4%) are",
   "matching_eligible": 226,
   "matching_days_of_supply": 5.7,
   "matching_complete": true,
   "top_posts": [
    {
     "post": "De9Uw8Ilhne",
     "count": 226
    },
    {
     "post": "DXzcVckxl22",
     "count": 14
    },
    {
     "post": "DYIeJvBmY3n",
     "count": 1
    },
    {
     "post": "DYSVfUiAANe",
     "count": 1
    },
    {
     "post": "DXZedtjkwOf",
     "count": 1
    }
   ],
   "top_comments": [
    {
     "comment": "roadmap",
     "count": 211
    },
    {
     "comment": "jeff",
     "count": 14
    },
    {
     "comment": "roadmaps",
     "count": 1
    },
    {
     "comment": "roadmqp",
     "count": 1
    },
    {
     "comment": "road map",
     "count": 1
    }
   ],
   "no_source_post": 5807,
   "warnings": [
    "226 leads match the strategy's audience — 5.7 days at 40/day",
    "audience mismatch: strategy is written for post /p/De9Uw8Ilhne or \"roadmap\" commenters; 226 of 6050 eligible leads scanned (4%) are"
   ]
  },
  "posts": [
   {
    "post": "De9Uw8Ilhne",
    "count": 226,
    "url": "https://www.instagram.com/p/De9Uw8Ilhne/",
    "comments": [
     {
      "comment": "roadmap",
      "count": 211
     },
     {
      "comment": "roadmaps",
      "count": 1
     },
     {
      "comment": "roadmqp",
      "count": 1
     }
    ]
   },
   {
    "post": "DXzcVckxl22",
    "count": 14,
    "url": "https://www.instagram.com/reel/DXzcVckxl22/",
    "comments": [
     {
      "comment": "jeff",
      "count": 14
     }
    ]
   },
   {
    "post": "DYIeJvBmY3n",
    "count": 1,
    "url": "https://www.instagram.com/p/DYIeJvBmY3n/",
    "comments": [
     {
      "comment": "design",
      "count": 1
     }
    ]
   },
   {
    "post": "DYSVfUiAANe",
    "count": 1,
    "url": "https://www.instagram.com/p/DYSVfUiAANe/",
    "comments": [
     {
      "comment": "die",
      "count": 1
     }
    ]
   },
   {
    "post": "DXZedtjkwOf",
    "count": 1,
    "url": "https://www.instagram.com/reel/DXZedtjkwOf/",
    "comments": [
     {
      "comment": "edit",
      "count": 1
     }
    ]
   }
  ],
  "strategy": {
   "id": 58,
   "bloq_id": 38,
   "name": "Roadmap Commenters | V1",
   "description": "2026-10-28: first DM for people who commented 'Roadmap' on instagram.com/p/De9Uw8Ilhne (AI roadmap giveaway). One step, no link.",
   "category": "cold_outreach",
   "usage_count": 174,
   "replies": 1,
   "last_reply_at": "2026-11-02T23:07:40+00:00",
   "steps": [
    {
     "id": 353,
     "title": "Instagram DM - Opener",
     "type": "instagram",
     "instructions": "Saw you're into AI. We built IRIS, an AI team that runs on your laptop and takes the busywork off your plate: content, emails, follow-ups, whatever's eating your time. It's free to start. What are you working on right now?",
     "order": 0,
     "delay_hours": 0,
     "ai_prompt": "Vary the wording slightly: swap a few words, rephrase one sentence. Do NOT chang…",
     "auto_execute": false
    }
   ]
  },
  "scan_limit": 10000
 }
}

export const AUDIENCE_CREATORS = {
 "measured": true,
 "reason": null,
 "data": {
  "campaign": {
   "id": 2,
   "name": "creators",
   "label": "Creator Outreach",
   "bloq_id": 80,
   "strategy_template_id": 59,
   "strategy_name": "IRIS for Creators | V1",
   "ig_account": "thediscoverpage_",
   "tw_account": "freelabelnet",
   "active": true,
   "is_live": true,
   "geo_tag": null,
   "starts_at": null,
   "ends_at": null,
   "audience_note": null,
   "eligible": 4185,
   "daily_cap": 40,
   "cap_source": "default",
   "days_of_supply": 104.6,
   "fits": null
  },
  "report": {
   "campaign": "creators",
   "active": true,
   "board": 80,
   "strategy": "IRIS for Creators | V1",
   "strategy_found": true,
   "eligible": 4185,
   "scanned": 4185,
   "daily_cap": 40,
   "days_of_supply": 104.6,
   "supply": "ok",
   "audience": "unstated",
   "audience_reason": "the strategy does not say which leads it is for, and no single source dominates the list",
   "matching_eligible": null,
   "matching_days_of_supply": null,
   "matching_complete": true,
   "top_posts": [
    {
     "post": "DYIeJvBmY3n",
     "count": 1919
    },
    {
     "post": "DYSVfUiAANe",
     "count": 1345
    },
    {
     "post": "DXZedtjkwOf",
     "count": 254
    },
    {
     "post": "DYQjxkYO-1A",
     "count": 85
    },
    {
     "post": "DRVaQlpj-SX",
     "count": 70
    }
   ],
   "top_comments": [
    {
     "comment": "design",
     "count": 1879
    },
    {
     "comment": "skill",
     "count": 687
    },
    {
     "comment": "die",
     "count": 571
    },
    {
     "comment": "edit",
     "count": 253
    },
    {
     "comment": "art",
     "count": 84
    }
   ],
   "no_source_post": 444,
   "warnings": []
  },
  "posts": [
   {
    "post": "DYIeJvBmY3n",
    "count": 1919,
    "url": "https://www.instagram.com/p/DYIeJvBmY3n/",
    "comments": [
     {
      "comment": "design",
      "count": 1879
     },
     {
      "comment": "guide",
      "count": 5
     },
     {
      "comment": "desing",
      "count": 3
     }
    ]
   },
   {
    "post": "DYSVfUiAANe",
    "count": 1345,
    "url": "https://www.instagram.com/p/DYSVfUiAANe/",
    "comments": [
     {
      "comment": "skill",
      "count": 687
     },
     {
      "comment": "die",
      "count": 571
     },
     {
      "comment": "skills",
      "count": 43
     }
    ]
   },
   {
    "post": "DXZedtjkwOf",
    "count": 254,
    "url": "https://www.instagram.com/reel/DXZedtjkwOf/",
    "comments": [
     {
      "comment": "edit",
      "count": 253
     },
     {
      "comment": "https aitoolbar in",
      "count": 1
     }
    ]
   },
   {
    "post": "DYQjxkYO-1A",
    "count": 85,
    "url": "https://www.instagram.com/p/DYQjxkYO-1A/",
    "comments": [
     {
      "comment": "art",
      "count": 84
     },
     {
      "comment": "art thank you",
      "count": 1
     }
    ]
   },
   {
    "post": "DRVaQlpj-SX",
    "count": 70,
    "url": "https://www.instagram.com/p/DRVaQlpj-SX/?img_index=1",
    "comments": [
     {
      "comment": "keishaperryesq",
      "count": 2
     },
     {
      "comment": "sheltondemar mrexecution time",
      "count": 1
     },
     {
      "comment": "love it",
      "count": 1
     }
    ]
   }
  ],
  "strategy": {
   "id": 59,
   "bloq_id": 80,
   "name": "IRIS for Creators | V1",
   "description": "2026-10-28: first DM only for @thediscoverpage_. Promises nothing Creator OS can't do yet (no bookings/merch/storefront). One question, no link.",
   "category": "cold_outreach",
   "usage_count": 0,
   "replies": null,
   "last_reply_at": null,
   "steps": [
    {
     "id": 354,
     "title": "Instagram DM - Opener",
     "type": "instagram",
     "instructions": "Saw you're into AI. We built IRIS, an AI team that runs on your laptop and takes the busywork off your plate: content, emails, follow-ups, whatever's eating your time. It's free to start. What are you working on right now?",
     "order": 0,
     "delay_hours": 0,
     "ai_prompt": "Vary the wording slightly: swap a few words, rephrase one sentence. Do NOT chang…",
     "auto_execute": false
    }
   ]
  },
  "scan_limit": 10000
 }
}

export const STRATEGIES = {
 "measured": true,
 "reason": "board 292: Bloq not found",
 "data": {
  "boards": [
   283,
   224,
   38,
   80,
   355,
   302,
   176,
   292
  ],
  "strategies": [
   {
    "id": 26,
    "bloq_id": 283,
    "name": "Beauty & Wellness Outreach | V1",
    "description": "Instagram-first outreach for beauty and wellness leads in Austin TX.",
    "category": "cold_outreach",
    "usage_count": 153,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 206,
      "title": "Instagram DM",
      "type": "instagram",
      "instructions": "Hey! Your page is so cute. I'm a lash girl here in Austin — would love to do your lashes sometime. I'll give you 30% off your first session. What does your schedule look like?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": "Write a casual Instagram DM from a lash artist named Lisa in Austin. Keep it fri…",
      "auto_execute": false
     },
     {
      "id": 207,
      "title": "Follow-up DM",
      "type": "instagram",
      "instructions": "Hey! Just circling back — I still have a few new client spots open this month. 30% off your first lash session, any style. Would love to get you in the chair! What days work best for you?",
      "order": 1,
      "delay_hours": 48,
      "ai_prompt": "Write a friendly follow-up DM from Lisa. Keep it light — just checking in, not p…",
      "auto_execute": false
     },
     {
      "id": 208,
      "title": "Email Outreach",
      "type": "email",
      "instructions": "Hi {first_name},\n\nI'm Lisa at ATX Beauty Lab here in Austin. I came across your profile and love your style — I think you'd really enjoy what we do here.\n\nI'm currently taking new clients and offering 30% off your first lash session (any style). Would love to have you in!\n\nBook directly here: https://atxbeautylab.glossgenius.com\n\nLisa\nATX Beauty Lab",
      "order": 2,
      "delay_hours": 96,
      "ai_prompt": "Write a warm, short email from Lisa at ATX Beauty Lab. Keep it personal — like a…",
      "auto_execute": false
     },
     {
      "id": 209,
      "title": "SMS Touch",
      "type": "sms",
      "instructions": "Hey {first_name}! It's Lisa from ATX Beauty Lab. Still have that 30% off for your first lash session if you want to come try us out. Lmk and I'll get you booked!",
      "order": 3,
      "delay_hours": 168,
      "ai_prompt": "Write a quick text from Lisa. Super casual — like texting a friend. Mention the …",
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 7,
      "label": "ATX Beauty Outreach",
      "active": false
     }
    ]
   },
   {
    "id": 27,
    "bloq_id": 224,
    "name": "DJ Outreach | V2",
    "description": null,
    "category": "cold_outreach",
    "usage_count": 98,
    "replies": 4,
    "last_reply_at": "2026-10-28T19:12:22+00:00",
    "steps": [
     {
      "id": 224,
      "title": "DM Invite",
      "type": "instagram",
      "instructions": "I love what you're doing! We run a weekly DJ night — Nights with NOYS — plus a whole community of DJs, producers and creatives who actually help each other win: live sets, direct intros, real industry connections. Would love to get you in the mix — you open to it?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": "Vary the wording slightly — swap a few words, rephrase one sentence. Do NOT chan…",
      "auto_execute": false
     },
     {
      "id": 283,
      "title": "NOYS Slot",
      "type": "instagram",
      "instructions": "Since you spin — we PAY for slots at Nights with NOYS every Saturday: Headliner $150, Opener $75. Submit your mix: https://web.freelabel.net/marketplace/opportunity/670",
      "order": 1,
      "delay_hours": 48,
      "ai_prompt": "Vary the wording slightly — swap a few words. Do NOT change the offer, amounts, …",
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 3,
      "label": "DJ Outreach",
      "active": false
     }
    ]
   },
   {
    "id": 58,
    "bloq_id": 38,
    "name": "Roadmap Commenters | V1",
    "description": "2026-10-28: first DM for people who commented 'Roadmap' on instagram.com/p/De9Uw8Ilhne (AI roadmap giveaway). One step, no link.",
    "category": "cold_outreach",
    "usage_count": 174,
    "replies": 1,
    "last_reply_at": "2026-11-02T23:07:40+00:00",
    "steps": [
     {
      "id": 353,
      "title": "Instagram DM - Opener",
      "type": "instagram",
      "instructions": "Saw you're into AI. We built IRIS, an AI team that runs on your laptop and takes the busywork off your plate: content, emails, follow-ups, whatever's eating your time. It's free to start. What are you working on right now?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": "Vary the wording slightly: swap a few words, rephrase one sentence. Do NOT chang…",
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 1,
      "label": "AI Course Outreach",
      "active": true
     }
    ]
   },
   {
    "id": 45,
    "bloq_id": 38,
    "name": "Founder Interview Series | V1",
    "description": "Selection-framed invite for AI founders/builders to be interviewed + featured (guest side). No product pitch. CTA = book an interview.",
    "category": "cold_outreach",
    "usage_count": 0,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 270,
      "title": "Invite — DM",
      "type": "instagram",
      "instructions": "Hey {first_name}! We're picking a handful of AI founders to interview for our build-in-public series. Saw what you're building — would love to have you on. Open to it?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 271,
      "title": "How it works — DM",
      "type": "instagram",
      "instructions": "We feature one founder at a time — short interview, we cut it into content and put your work in front of our community. No cost, just curating builders with real momentum. Want me to send a couple time slots?",
      "order": 1,
      "delay_hours": 48,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 272,
      "title": "Personal follow-up — DM",
      "type": "instagram",
      "instructions": "Hey {first_name}, following up — genuinely think your project would resonate with our audience. The interview's ~20 min, super low-key. Want to grab a slot this week?",
      "order": 2,
      "delay_hours": 48,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 273,
      "title": "Soft close — DM",
      "type": "instagram",
      "instructions": "No worries if the timing's off — we run these weekly, so I can keep you in mind for an upcoming one. Just lmk if you want in.",
      "order": 3,
      "delay_hours": 96,
      "ai_prompt": null,
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 10,
      "label": "AI Founder Interview Series",
      "active": false
     }
    ]
   },
   {
    "id": 59,
    "bloq_id": 80,
    "name": "IRIS for Creators | V1",
    "description": "2026-10-28: first DM only for @thediscoverpage_. Promises nothing Creator OS can't do yet (no bookings/merch/storefront). One question, no link.",
    "category": "cold_outreach",
    "usage_count": 0,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 354,
      "title": "Instagram DM - Opener",
      "type": "instagram",
      "instructions": "Saw you're into AI. We built IRIS, an AI team that runs on your laptop and takes the busywork off your plate: content, emails, follow-ups, whatever's eating your time. It's free to start. What are you working on right now?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": "Vary the wording slightly: swap a few words, rephrase one sentence. Do NOT chang…",
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 2,
      "label": "Creator Outreach",
      "active": true
     }
    ]
   },
   {
    "id": 46,
    "bloq_id": 80,
    "name": "Creator Feature Series | V1",
    "description": "Selection-framed invite for creators to be interviewed + featured on The Discover Page (guest side). No product pitch. CTA = book an interview.",
    "category": "cold_outreach",
    "usage_count": 0,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 274,
      "title": "Invite — DM",
      "type": "instagram",
      "instructions": "Hey {first_name}! We're selecting a few creators to feature + interview on The Discover Page. Loved your content — would be dope to have you on. Down?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 275,
      "title": "How it works — DM",
      "type": "instagram",
      "instructions": "How it works: quick interview, we turn it into content and put you in front of our community. No cost — we're just curating creators with a real voice. Want a couple time slots?",
      "order": 1,
      "delay_hours": 48,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 276,
      "title": "Personal follow-up — DM",
      "type": "instagram",
      "instructions": "Hey {first_name}, circling back — think your stuff would hit with our audience. Interview's ~20 min, relaxed. Want to lock a slot this week?",
      "order": 2,
      "delay_hours": 48,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 277,
      "title": "Soft close — DM",
      "type": "instagram",
      "instructions": "All good if now's not it — we feature creators weekly, happy to keep you on the list for the next round. Just say the word.",
      "order": 3,
      "delay_hours": 96,
      "ai_prompt": null,
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 11,
      "label": "Creator Feature Series",
      "active": false
     }
    ]
   },
   {
    "id": 35,
    "bloq_id": 355,
    "name": "Artist Outreach | FFAT V1",
    "description": "First Friday Art Trail (Fri Jul 3, 2026 @ Hope Outdoor Gallery, Austin) — artist/performer outreach from @freelabelnet",
    "category": "cold_outreach",
    "usage_count": 102,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 278,
      "title": "FFAT Slot Invite",
      "type": "instagram",
      "instructions": "Hey {first_name}! I love what you're doing — we're putting together our next live showcase, bringing artists, producers, managers + creatives together to actually help each other win. Would love to have you plugged in — you open to it?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": "Vary the wording slightly — swap a few words, rephrase one sentence. Do NOT chan…",
      "auto_execute": false
     },
     {
      "id": 284,
      "title": "Locals Only Slot",
      "type": "instagram",
      "instructions": "Also — perform at Locals Only, our open-mic showcase. Song Wars III members grab a slot here: https://web.freelabel.net/marketplace/opportunity/671",
      "order": 1,
      "delay_hours": 48,
      "ai_prompt": "Vary the wording slightly — swap a few words. Do NOT change the offer, amounts, …",
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 6,
      "label": "FFAT Artists (Austin)",
      "active": false
     }
    ]
   },
   {
    "id": 31,
    "bloq_id": 302,
    "name": "LinkedIn Founder Outreach | V1",
    "description": null,
    "category": "cold_outreach",
    "usage_count": 0,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 210,
      "title": "LinkedIn Connection Request",
      "type": "linkedin",
      "instructions": "Send connection request: 'Hey {first_name}, I help {company} founders get their finances dialed — AI-powered ops that cut admin time 70%. Would love to connect.'",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 211,
      "title": "LinkedIn Follow-Up DM",
      "type": "linkedin",
      "instructions": "Once connected: 'Thanks for connecting {first_name}! Quick question — how are you handling financial ops right now? We built something called Good Deals that wires Atlas (AI chief of staff) to your QuickBooks. Happy to show you the 4-min Lean Canvas quiz: https://heyiris.io/p/good-deals#lean-canvas-quiz'",
      "order": 1,
      "delay_hours": 48,
      "ai_prompt": null,
      "auto_execute": false
     },
     {
      "id": 212,
      "title": "Value Drop DM",
      "type": "linkedin",
      "instructions": "Share value: 'Hey {first_name} — just shipped our Operational HQ dashboard. Think Notion + QuickBooks + CRM on one glass pane, run by AI agents. Here is what it looks like for a 12-deal pipeline: https://heyiris.io/p/dream-hq — worth 10 seconds of your time.'",
      "order": 2,
      "delay_hours": 96,
      "ai_prompt": null,
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 8,
      "label": "Good Deals Outreach",
      "active": false
     }
    ]
   },
   {
    "id": 21,
    "bloq_id": 176,
    "name": "Mayo Outreach | V2",
    "description": null,
    "category": "cold_outreach",
    "usage_count": 216,
    "replies": null,
    "last_reply_at": null,
    "steps": [
     {
      "id": 221,
      "title": "DM Invite",
      "type": "instagram",
      "instructions": "I saw what you're working on — I built an AI platform that powers live events, streams, and creator tools. We just did a showcase where clips hit over a million views and I stream the build process daily on Twitch. We're putting together a network of creators, artists, and builders who want to collab. Would you be down to come on the stream or pull up to the next event?",
      "order": 0,
      "delay_hours": 0,
      "ai_prompt": "Vary the wording slightly — swap a few words, rephrase one sentence. Do NOT chan…",
      "auto_execute": false
     },
     {
      "id": 222,
      "title": "The Community",
      "type": "instagram",
      "instructions": "We've got a Discord where the whole crew hangs — artists, DJs, developers, and creators building and performing together. I stream builds live, we plan events, and the AI handles booking, promo, and discovery for everyone in the network. Want the invite?",
      "order": 1,
      "delay_hours": 24,
      "ai_prompt": "Vary the wording slightly — swap a few words, rephrase one sentence. Do NOT chan…",
      "auto_execute": false
     },
     {
      "id": 223,
      "title": "Stream + Event Link",
      "type": "instagram",
      "instructions": "Going live again today building on stream. We're also putting together our next builder session — founders, devs and creators linking up to share what they're working on and swap notes. Want me to save you a spot? twitch.tv/hourdemayo Submit to guest here: https://web.freelabel.net/marketplace/opportunity/672",
      "order": 2,
      "delay_hours": 72,
      "ai_prompt": "Vary the wording slightly — swap a few words, rephrase one sentence. Do NOT chan…",
      "auto_execute": false
     }
    ],
    "campaigns": [
     {
      "id": 4,
      "label": "Mayo Outreach",
      "active": false
     }
    ]
   }
  ]
 }
}

export const COMMS = {
 "measured": true,
 "conversations": [
  {
   "key": "lead:1000",
   "leadId": 1000,
   "bloqId": 38,
   "name": "Lead A",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-13T17:08:45.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 1, text removed)",
   "lastInboundAt": "2026-11-13T17:08:45.000000Z",
   "inbound": 16,
   "outbound": 0,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1001",
   "leadId": 1001,
   "bloqId": 314,
   "name": "Lead B",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-13T03:30:55.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 2, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-13T03:30:55.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false,
   "status": "Prospected"
  },
  {
   "key": "lead:1002",
   "leadId": 1002,
   "bloqId": 80,
   "name": "Lead C",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-10T16:10:40.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 3, text removed)",
   "lastInboundAt": "2026-11-10T16:10:40.000000Z",
   "inbound": 1,
   "outbound": 1,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1003",
   "leadId": 1003,
   "name": "Lead D",
   "channel": "gmail",
   "channels": [
    "gmail"
   ],
   "lastAt": "2026-11-09T19:55:18.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 4, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-09T18:53:54.000000Z",
   "inbound": 5,
   "outbound": 7,
   "needsReply": false,
   "assigned": false,
   "status": "Qualified"
  },
  {
   "key": "form:4",
   "name": "Lead E",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-09T19:20:35.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 5, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-09T19:20:35.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false
  },
  {
   "key": "lead:1005",
   "leadId": 1005,
   "bloqId": 314,
   "name": "Lead F",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-09T18:38:16.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 6, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-09T18:38:16.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false,
   "status": "Prospected"
  },
  {
   "key": "lead:1006",
   "leadId": 1006,
   "bloqId": 38,
   "name": "Lead G",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-07T05:08:42.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 7, text removed)",
   "lastInboundAt": "2026-11-07T05:08:42.000000Z",
   "inbound": 20,
   "outbound": 5,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1007",
   "leadId": 1007,
   "bloqId": 314,
   "name": "Lead H",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-07T01:01:01.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 8, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-07T01:01:01.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false,
   "status": "Prospected"
  },
  {
   "key": "lead:1008",
   "leadId": 1008,
   "bloqId": 80,
   "name": "Lead I",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-06T17:10:32.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 9, text removed)",
   "lastInboundAt": "2026-11-06T17:10:32.000000Z",
   "inbound": 12,
   "outbound": 13,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1009",
   "leadId": 1009,
   "bloqId": 80,
   "name": "Lead J",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-06T15:10:35.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 10, text removed)",
   "lastInboundAt": "2026-11-06T15:10:35.000000Z",
   "inbound": 4,
   "outbound": 3,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1010",
   "leadId": 1010,
   "bloqId": 80,
   "name": "Lead K",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-06T14:10:28.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 11, text removed)",
   "lastInboundAt": "2026-11-06T14:10:28.000000Z",
   "inbound": 1,
   "outbound": 1,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "form:11",
   "bloqId": 170,
   "name": "Lead L",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-05T22:52:03.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 12, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-05T22:52:03.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false
  },
  {
   "key": "lead:1012",
   "leadId": 1012,
   "bloqId": 38,
   "name": "Lead M",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-05T12:09:10.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 13, text removed)",
   "lastInboundAt": "2026-11-05T12:09:10.000000Z",
   "inbound": 19,
   "outbound": 6,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1013",
   "leadId": 1013,
   "bloqId": 38,
   "name": "Lead N",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-04T22:18:56.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 14, text removed)",
   "lastInboundAt": "2026-11-04T08:08:49.000000Z",
   "inbound": 5,
   "outbound": 3,
   "needsReply": false,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1014",
   "leadId": 1014,
   "bloqId": 80,
   "name": "Lead O",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-04T21:10:25.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 15, text removed)",
   "lastInboundAt": "2026-11-04T21:10:25.000000Z",
   "inbound": 2,
   "outbound": 2,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1015",
   "leadId": 1015,
   "bloqId": 80,
   "name": "Lead P",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-04T20:45:29.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 16, text removed)",
   "lastInboundAt": "2026-11-04T00:10:29.000000Z",
   "inbound": 13,
   "outbound": 6,
   "needsReply": false,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1016",
   "leadId": 1016,
   "name": "Lead Q",
   "channel": "gmail",
   "channels": [
    "gmail"
   ],
   "lastAt": "2026-11-04T19:48:13.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 17, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-04T18:46:54.000000Z",
   "inbound": 1,
   "outbound": 2,
   "needsReply": false,
   "assigned": false,
   "status": "Contacted"
  },
  {
   "key": "lead:1017",
   "leadId": 1017,
   "name": "Lead R",
   "channel": "gmail",
   "channels": [
    "gmail"
   ],
   "lastAt": "2026-11-04T19:47:48.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 18, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-04T18:46:50.000000Z",
   "inbound": 1,
   "outbound": 2,
   "needsReply": false,
   "assigned": false,
   "status": "Contacted"
  },
  {
   "key": "lead:1018",
   "leadId": 1018,
   "name": "Lead S",
   "channel": "gmail",
   "channels": [
    "gmail"
   ],
   "lastAt": "2026-11-04T19:47:22.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 19, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-04T18:46:52.000000Z",
   "inbound": 1,
   "outbound": 2,
   "needsReply": false,
   "assigned": false,
   "status": "Contacted"
  },
  {
   "key": "lead:1019",
   "leadId": 1019,
   "bloqId": 314,
   "name": "Lead T",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-04T16:52:04.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 20, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-04T16:52:04.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false,
   "status": "Prospected"
  },
  {
   "key": "lead:1020",
   "leadId": 1020,
   "bloqId": 80,
   "name": "Lead U",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-03T19:44:56.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 21, text removed)",
   "lastInboundAt": "2026-11-03T19:44:56.000000Z",
   "inbound": 17,
   "outbound": 1,
   "needsReply": true,
   "assigned": false,
   "status": "Follow Up"
  },
  {
   "key": "lead:1021",
   "leadId": 1021,
   "bloqId": 80,
   "name": "Lead V",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-03T05:10:32.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 22, text removed)",
   "lastInboundAt": "2026-11-03T05:10:32.000000Z",
   "inbound": 9,
   "outbound": 2,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1022",
   "leadId": 1022,
   "bloqId": 314,
   "name": "Lead W",
   "channel": "contact_form",
   "channels": [
    "contact_form"
   ],
   "lastAt": "2026-11-03T04:06:40.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 23, text removed)",
   "subject": "(subject removed)",
   "lastInboundAt": "2026-11-03T04:06:40.000000Z",
   "inbound": 1,
   "outbound": 0,
   "needsReply": true,
   "assigned": false,
   "status": "Prospected"
  },
  {
   "key": "lead:1023",
   "leadId": 1023,
   "bloqId": 38,
   "name": "Lead X",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-03T01:08:43.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 24, text removed)",
   "lastInboundAt": "2026-11-03T01:08:43.000000Z",
   "inbound": 9,
   "outbound": 5,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1024",
   "leadId": 1024,
   "bloqId": 80,
   "name": "Lead Y",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-03T00:18:46.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 25, text removed)",
   "lastInboundAt": "2026-11-01T17:10:27.000000Z",
   "inbound": 2,
   "outbound": 2,
   "needsReply": false,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1025",
   "leadId": 1025,
   "bloqId": 38,
   "name": "Lead Z",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-02T23:07:39.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 26, text removed)",
   "lastInboundAt": "2026-11-02T23:07:39.000000Z",
   "inbound": 1,
   "outbound": 1,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1026",
   "leadId": 1026,
   "bloqId": 38,
   "name": "Lead A1",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-01T13:20:42.000000Z",
   "lastDirection": "outbound",
   "preview": "(message 27, text removed)",
   "lastInboundAt": "2026-10-31T17:15:14.000000Z",
   "inbound": 1,
   "outbound": 2,
   "needsReply": false,
   "assigned": false,
   "status": "Responded"
  },
  {
   "key": "lead:1027",
   "leadId": 1027,
   "bloqId": 80,
   "name": "Lead B1",
   "channel": "instagram",
   "channels": [
    "instagram"
   ],
   "lastAt": "2026-11-01T13:11:36.000000Z",
   "lastDirection": "inbound",
   "preview": "(message 28, text removed)",
   "lastInboundAt": "2026-11-01T13:11:36.000000Z",
   "inbound": 4,
   "outbound": 2,
   "needsReply": true,
   "assigned": false,
   "status": "Responded"
  }
 ],
 "total": 28,
 "days": 14,
 "truncated": false,
 "counts": {
  "all": 28,
  "needsReply": 20,
  "assigned": 0,
  "channels": {
   "instagram": 17,
   "contact_form": 7,
   "gmail": 4
  }
 }
}

export const BATCHES = {
 "measured": true,
 "data": []
}

