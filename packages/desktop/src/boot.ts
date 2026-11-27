// The one script index.html loads. The iPhone build (#194511) has no engine of its own, so it
// gets its own entry; the desktop entry stays exactly as it was.
import { opencodeGlobal } from "./opencode-global"

void (opencodeGlobal().mobile ? import("./mobile") : import("./index"))
