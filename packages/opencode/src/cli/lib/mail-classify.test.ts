import { describe, test, expect } from "bun:test"
import { classifySender } from "./mail-classify"

// =============================================================================
// #189480 — "respond to the job outreach emails in my inbox". Of ~120 job emails in
// 30 days most were LinkedIn / Jobot / Lensa alerts, and the handful of real
// recruiters were buried under them. Nothing told the two apart.
//
// The expensive mistake is the one-way one: a real recruiter filed as an alert is
// never answered. So the tests below lean on the cases that LOOK automated and are
// people — a LinkedIn InMail, a Jobot recruiter writing from the same domain that
// sends Jobot's alerts.
// =============================================================================

const c = (sender: string, senderName = "", subject = "") => classifySender({ sender, senderName, subject })

describe("classifySender — alerts", () => {
  test.each([
    ["jobalerts-noreply@linkedin.com", "LinkedIn Job Alerts", "Software Engineer: Acme and 10 more"],
    ["jobs-listings@linkedin.com", "LinkedIn", "Apply now to Senior Engineer"],
    ["no-reply@jobot.com", "Jobot", "New jobs for you"],
    ["jobs@lensa.com", "Lensa", "Senior Developer at Initech"],
    ["noreply@glassdoor.com", "Glassdoor Jobs", "8 new jobs in Dallas"],
    ["alert@indeed.com", "Indeed", "Software engineer jobs near you"],
    ["phil@ziprecruiter.com", "Phil from ZipRecruiter", "A job you might like"],
    ["notifications@hiring.example.com", "Example Hiring", "Your application was received"],
  ])("%s is an alert", (sender, name, subject) => {
    expect(c(sender, name, subject).kind).toBe("alert")
  })

  test("a bulk subject from an unknown sender is an alert", () => {
    expect(c("talent@somestartup.io", "Somestartup", "12 new jobs matching your profile").kind).toBe("alert")
  })
})

describe("classifySender — people", () => {
  test.each([
    ["jane.doe@acme.com", "Jane Doe", "Opportunity at Acme"],
    // Jobot recruiters write from the same domain as Jobot's alerts. Domain alone is not evidence.
    ["sarah.kim@jobot.com", "Sarah Kim", "Senior Laravel role — quick chat?"],
    // InMail notifications arrive from a LinkedIn address but are a person writing to you.
    ["inmail-hit-reply@linkedin.com", "Mike Ross via LinkedIn", "Platform Engineer role"],
    ["messages-noreply@linkedin.com", "Priya Patel via LinkedIn", "Priya sent you a message"],
    // An employer replying through Indeed's relay is a person, unlike alert@indeed.com.
    ["employer-abc123@indeedemail.com", "Hiring Manager", "Re: your application"],
  ])("%s is a person", (sender, name, subject) => {
    expect(c(sender, name, subject).kind).toBe("person")
  })
})

// Real senders from one 30-day inbox, measured 2026-10-15 through the Hive node. The first
// cut of this classifier called every one of the marketing senders below a "person" — 101
// "people" out of 197, nearly all of them shops. Mail's own index columns (list_id_hash,
// unsubscribe_type, automated_conversation) were checked as a signal and do NOT separate
// these: a staffing firm's recruiters and Wayfair scored identically.
describe("classifySender — marketing mail is not a person (measured inbox)", () => {
  test.each([
    ["info@e.taxact.com", "TaxAct", "Two days left to file your taxes"],
    ["editor@members.wayfair.com", "Wayfair", "HOLIDAY DEAL WEEK"],
    ["store+1000000001@m.shopifyemail.com", "ZUGO Bike", "Keep Your ZUGO Bike Clean"],
    ["info@email.plaid.com", "Plaid", "Instant onboarding"],
    ["events@plaid.com", "Plaid", "You're invited"],
    ["rewards@mp1.tripadvisor.com", "Tripadvisor", "Your summer pics"],
    ["reply@ss.email.nextdoor.com", "Weber Hill Trending Posts", "vote them ALL out"],
    ["email@skmarketing.smoothieking.com", "Smoothie King", "Our secret ingredient?"],
    ["announce@m.parallels.com", "Parallels", "Unlock more possibilities"],
    ["beats@insideapple.apple.com", "Beats by Dre", "Catch the Pokémon Beats Pill"],
    ["info@treesdallas.com", "Trees", "We got your Friday covered!"],
    ["jobs@alerts.jobot.com", "Jobot", "Software Engineer roles"],
    ["southwest@events.aegpresents.com", "AEG Presents Southwest", "Weekly Roundup"],
    ["homesense@eml.homesense.com", "Homesense", "LOOK OUT these might be gone soon"],
    ["Costco@digital.costco.com", "Costco Wholesale", "Discover Quality Upgrades"],
    ["Azure@mails.microsoft.com", "Microsoft Azure", "Solutions recommended for you"],
  ])("%s is an alert", (sender, name, subject) => {
    expect(c(sender, name, subject).kind).toBe("alert")
  })

  test.each([
    ["jpatel@staffingco.com", "Staffing Co", "Contract-to-hire Role - Senior Software Engineer (.NET/ Cloud)"],
    ["mlee@staffingco.com", "Staffing Co", "React Engineer - Hybrid"],
    ["rkhan@staffingco.com", "Staffing Co", "Laravel Developer"],
    // Recruiting TEAMS write from role mailboxes. Calling them alerts would bury exactly the
    // mail this exists to surface.
    ["careers@acme.com", "Acme Careers", "Next steps for your application"],
    ["recruiting@initech.com", "Initech Recruiting", "Interview availability"],
    ["talent@somestartup.io", "Somestartup Talent", "Founding engineer — chat?"],
    ["dana.fox@consultfirm.com", "Dana Fox", "SAP CPI Consultant ROLE AVAILABLE"],
    ["lucyb@agencyinc.com", "Lucy Brown", "Remote - Program Manager"],
    // A named recruiter on a staffing firm's alert HOST. Left as a person on purpose: the
    // classifier only says "alert" on evidence, and a hidden recruiter costs more than an ad.
    ["Jordan.Reyes@jobalert.staffingfirm.com", "Jordan Reyes", "New Role in Austin, TX"],
  ])("%s is a person", (sender, name, subject) => {
    expect(c(sender, name, subject).kind).toBe("person")
  })
})

describe("classifySender — the reason travels with the answer", () => {
  test("every verdict says why", () => {
    expect(c("jobalerts-noreply@linkedin.com").why).toMatch(/automated|no-?reply|alert/i)
    expect(c("jane.doe@acme.com", "Jane Doe").why.length).toBeGreaterThan(0)
  })

  test("case and whitespace do not change the answer", () => {
    expect(c("  JobAlerts-NoReply@LinkedIn.com ").kind).toBe("alert")
  })

  test("an empty sender is not silently a person", () => {
    expect(c("").kind).toBe("unknown")
  })
})
