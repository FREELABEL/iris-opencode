import { describe, expect, test } from "bun:test"
import { audioStatus, fileKeys, matchTracks, titleKey, variantPenalty } from "./platform-freelabel-studio"

// Real titles and file names from profile 69 and its Drive folder (2026-10-04).
const files = [
  "Yung Mayo/I Cant f. @JonnnyB.mp3",
  "Yung Mayo/@SirAlexMayo - AMR Vol. 4.mp3",
  "Yung Mayo/@SirAlexMayo - AMR Vol. 5.mp3",
  "Paralells/Unfuxwidable pt. 2.mp3",
  "Yung Mayo/She - JohnnyB theShooter ft Lil 93.mp3",
  "Yung Mayo/She - JohnnyB theShooter ft Lil 93 [v2.0].mp3",
  "Yung Mayo/100M $ Convo f. Johnny B.mp3",
  "Yung Mayo/5 Piece f. Don Von Dodi.mp3",
  "Yung Mayo/5 Piece f. Don Von Dodi_1.mp3",
  "Yung Mayo/5 Piece - vox.mp3",
  "Yung Mayo/5 Piece - full.mp3",
  "Yung Mayo/Work For Birk.mp3",
  "Yung Mayo/Work For Birk (Remastered).mp3",
  "Yung Mayo/Been That Nigga.mp3",
  "Yung Mayo/Been That Nigga II.mp3",
  "Yung Mayo/RIGHT!.mp3",
  "Yung Mayo/RIGhtNOW.mp3",
  "Yung Mayo/Protect My Wrist.wav",
  "Yung Mayo/Protect My Wrist.mp3",
  "Yung Mayo/Again.mp3",
  "Yung Mayo/Never Work A Job Again.mp3",
]
const t = (id: number, title: string) => ({ id, title, preview_url: null })
const pick = (title: string) => matchTracks([t(1, title)], files)[0].file

describe("freelabel upload — title matching", () => {
  test("credits, handle prefixes, brackets and plurals do not block a match", () => {
    expect(pick("I Cant f. @JohnnyBTheShooter")).toBe("Yung Mayo/I Cant f. @JonnnyB.mp3")
    expect(pick("I CANT f. @JohnnyBtheShooter")).toBe("Yung Mayo/I Cant f. @JonnnyB.mp3")
    expect(pick("@SirAlexMayo - AMR Vol. 4")).toBe("Yung Mayo/@SirAlexMayo - AMR Vol. 4.mp3")
    expect(pick("Unfuxwidable pt 2 [SOLO DEMO]")).toBe("Paralells/Unfuxwidable pt. 2.mp3")
    expect(pick("100M $ Convos")).toBe("Yung Mayo/100M $ Convo f. Johnny B.mp3")
    expect(pick("RIGHT! f. SLVMP CEE")).toBe("Yung Mayo/RIGHT!.mp3")
  })

  test("the plain mix beats alternates; mp3 beats wav", () => {
    expect(pick("SHE f. @JohnnyBTheShooter")).toBe("Yung Mayo/She - JohnnyB theShooter ft Lil 93.mp3")
    expect(pick("5 Piece f. @DonVonDodi")).toBe("Yung Mayo/5 Piece f. Don Von Dodi.mp3")
    expect(pick("Work for Birk Ft. @SLVMPCEE")).toBe("Yung Mayo/Work For Birk.mp3")
    expect(pick("Protect My Wrist")).toBe("Yung Mayo/Protect My Wrist.mp3")
  })

  test("a near name is not a match", () => {
    expect(pick("Been That Nigga II")).toBe("Yung Mayo/Been That Nigga II.mp3")
    expect(pick("Again")).toBe("Yung Mayo/Again.mp3") // not "Never Work A Job Again"
    expect(pick("Cadence")).toBeNull()
  })

  test("alternatives are reported so a person can choose", () => {
    expect(matchTracks([t(1, "5 Piece f. @DonVonDodi")], files)[0].alternatives.length).toBe(3)
  })

  test("helpers", () => {
    expect(titleKey("2020 - Untitled Master")).toBe("2020untitledmaster")
    expect(fileKeys("She - JohnnyB theShooter ft Lil 93.mp3")).toContain("she")
    expect(variantPenalty("x.mp3")).toBe(0)
    expect(audioStatus({ id: 1, title: "x", preview_url: null, embed_url: "https://w.soundcloud.com/player/?url=x" })).toBe("soundcloud")
    expect(audioStatus({ id: 1, title: "x", preview_url: null })).toBe("no audio")
  })
})
