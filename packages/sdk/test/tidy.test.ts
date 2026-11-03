import { describe, expect, it } from "vitest";
import { firstProblem, textProblem, tidyName, tidyText } from "../src/index.js";

describe("tidyName", () => {
  it("brings a shouted name to title case, keeping states and rig terms", () => {
    expect(tidyName("LAKE EPPALOCK REST AREA")).toBe("Lake Eppalock Rest Area");
    expect(tidyName("BIG4 BALLINA NSW")).toBe("BIG4 Ballina NSW");
    expect(tidyName("BANKS OF THE MURRAY 4WD CAMP")).toBe("Banks of the Murray 4WD Camp");
  });

  it("capitalises an all lower case name", () => {
    expect(tidyName("old gravel pit")).toBe("Old Gravel Pit");
    expect(tidyName("cape york-weipa road camp")).toBe("Cape York-Weipa Road Camp");
  });

  it("leaves a name already in mixed case, but for a shouted word", () => {
    expect(tidyName("McKinlay Rest Area")).toBe("McKinlay Rest Area");
    expect(tidyName("Old GRAVEL Pit")).toBe("Old Gravel Pit");
  });

  it("tidies spacing and repeats", () => {
    expect(tidyName("  River \n Bend!!!  ")).toBe("River Bend!");
    expect(tidyName("Stage III Camp")).toBe("Stage III Camp");
  });
});

describe("tidyText", () => {
  it("turns shouting into sentences", () => {
    expect(tidyText("GREAT SPOT. NO TOILETS BUT LOTS OF SHADE!!!! I LOVED IT")).toBe("Great spot. No toilets but lots of shade! I loved it");
    expect(tidyText("ROAD IS 4WD ONLY AFTER RAIN. NPWS FEES APPLY")).toBe("Road is 4WD only after rain. NPWS fees apply");
  });

  it("lowers a shouted word in ordinary text", () => {
    expect(tidyText("The road is VERY rough, NSW side")).toBe("The road is very rough, NSW side");
  });

  it("shortens drawn-out letters and punctuation", () => {
    expect(tidyText("Sooooo quiet..... loved it???")).toBe("Soo quiet... loved it?");
  });

  it("keeps paragraphs but not runs of blank lines", () => {
    expect(tidyText("One  line \n\n\n\n Two")).toBe("One line\n\nTwo");
  });
});

describe("textProblem", () => {
  it("passes ordinary notes", () => {
    expect(textProblem("Flat gravel pit off the highway, room for big rigs. Open 0800-1700.")).toBeNull();
    expect(textProblem("Cockburn Sound lookout, Scunthorpe Road")).toBeNull();
    expect(textProblem("Bitchumen all the way to the camp")).toBeNull();
    expect(textProblem("Near the Niger Street bridge")).toBeNull();
  });

  it("finds rude words, however they are spelt", () => {
    expect(textProblem("this place is shit")).toBe("rude");
    expect(textProblem("F U C K this road")).toBe("rude");
    expect(textProblem("total sh1t hole")).toBe("rude");
    expect(textProblem("fuuuuckin dusty")).toBe("rude");
    expect(textProblem("Bullshit fees")).toBe("rude");
  });

  it("finds links, emails and phone numbers", () => {
    expect(textProblem("Book at www.example.com.au")).toBe("contact");
    expect(textProblem("Ring 0412 345 678")).toBe("contact");
  });

  it("finds spam and keyboard mashing", () => {
    expect(textProblem("Best camp, follow me for more")).toBe("spam");
    expect(textProblem("good good good good camp")).toBe("spam");
    expect(textProblem("asdfghjkl")).toBe("spam");
    expect(textProblem("hahahahahahahahahahahaha")).toBe("spam");
    expect(textProblem("!!! ???")).toBe("spam");
  });
});

describe("firstProblem", () => {
  it("gives the first problem across several texts, skipping missing ones", () => {
    expect(firstProblem("Old Gravel Pit", undefined, "Ring 0412 345 678", "this place is shit")).toBe("contact");
    expect(firstProblem("Old Gravel Pit", undefined)).toBeNull();
  });
});
