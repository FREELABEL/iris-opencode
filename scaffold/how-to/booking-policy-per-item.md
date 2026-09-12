---
category: CRM & Sales
level: intermediate
tags: [booking, stripe, identity, inventory, charge-mode, policy]
duration_min: 10
---
# Per-item booking policy (charge mode + ID verification)

Set how each item in a bookable inventory charges, and whether it needs identity
verification — per ITEM, with an account-wide default underneath.

Built for a car-rental tenant, but nothing in it is car-specific: it works for any
bookable inventory — venues, equipment, studio time.

## The model

Policy resolves in three steps, and the FIRST hit wins:

    item.charge_mode  ->  bloq.config.charge_mode  ->  none

Blank on the item means "inherit". `none` on the item is a REAL policy (take no money) and
is not the same as blank — that distinction is what lets an operator turn charging OFF for
one vehicle under a `full` account default.

Same resolution for `kyc_mode`: `none | at_booking | at_checkout`.

Enforcement is SERVER-SIDE, inside the request. `/payment-intent` quotes from it and
`book()`'s charge gate re-checks it — a client cannot self-assert "paid" or "verified".

## Charge modes

    none          a reservation is a request; settle off-platform
    card_on_file  save the card, move no money
    deposit       fixed amount now (deposit_cents), balance later
    full          the whole reservation now
    hold          AUTHORIZE now, capture on delivery

> **hold carries an obligation.** A Stripe authorization expires in ~7 days and captures
> nothing if nobody acts. Do not enable it for a tenant until an operator can actually
> capture — otherwise it is a money leak with a nice UI.

## ID verification

Stripe Identity costs about **$2 per check**, so this is a per-booking COST decision, not a
feature flag. `at_booking` spends the $2 even on bookings that get cancelled; `at_checkout`
only spends it once the rental is real. High-value items and long rentals justify the spend;
a two-day economy booking may not.

## Set it from the dashboard (the normal way)

Drop the `FleetPolicyBoard` component on an atlas-gated dashboard page:

    {
      "type": "FleetPolicyBoard",
      "props": {
        "app": "<your-app>-dashboard",
        "collection": "fleet",
        "pageSlug": "<your-app>-dashboard",
        "defaultChargeMode": "full",
        "defaultKycMode": "none",
        "chargeModes": ["none", "deposit", "full"],
        "themeMode": "light"
      }
    }

Narrow `chargeModes` to hide a mode a tenant should not use yet — e.g. omit `hold` until
capture is proven end to end.

The board also filters to items **missing photos**, with a count, so a client can see
exactly which inventory still needs imagery.

Writes ride the atlas session cookie, so the page must be gated.

## Set it from the CLI (ops / debugging)

    php artisan fleet:policy <tenant-slug>                    # list; ( ) = inherited
    php artisan fleet:policy <tenant-slug> --missing-photos
    php artisan fleet:policy <tenant-slug> --set=<item-id> --charge=hold --kyc=at_booking
    php artisan fleet:policy <tenant-slug> --set=<item-id> --charge=inherit   # clears the override

Account-wide default:

    php artisan booking:set-charge-mode <slug> full
    php artisan booking:inspect <slug>                    # what is set + where money routes

`booking:set-charge-mode` REFUSES to enable charging unless `config.stripe.payee_user_id`
resolves to a user with a connected account — without an explicit payee the charge falls back
to the bloq owner, which on an agency-owned bloq means the PLATFORM gets the money instead of
the client.

## The footgun: two configs, both required

Charging needs BOTH:

1. the server policy (this recipe) — the source of truth, prices and gates
2. the wizard's `paymentMode` prop in the page JSON — renders the Payment Element

Set only the prop and the intent endpoint reports "nothing to pay" and the booking proceeds
uncharged. Set only the server side and `book()` 422s `payment_required`.

## Verify it

    curl -sX POST https://<host>/api/v1/public/booking/<slug>/payment-intent \
      -H 'content-type: application/json' \
      --data '{"resource_key":"<item id>","start_time":"...","end_time":"..."}'

Look for `mode`, `charge_cents`, and `mode_source` (`vehicle` | `bloq` | `default`) —
`mode_source` tells you WHICH level answered, which is the fastest way to confirm an override
actually took.
