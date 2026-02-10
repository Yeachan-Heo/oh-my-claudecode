/**
 * Tests for Skill Parser
 */

import { describe, it, expect } from "vitest";
import { parseSkillFile } from "../../../hooks/learner/parser.js";

describe("parseSkillFile", () => {
  describe("backward compatibility", () => {
    it("should parse skill with only name, description, and triggers (no id, no source)", () => {
      const content = `---
name: DateTime Helper
description: Help with date and time operations
triggers:
  - datetime
  - time
  - date
---

This skill helps with date and time operations.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.metadata.name).toBe("DateTime Helper");
      expect(result.metadata.description).toBe(
        "Help with date and time operations",
      );
      expect(result.metadata.triggers).toEqual(["datetime", "time", "date"]);
      expect(result.metadata.id).toBe("datetime-helper");
      expect(result.metadata.source).toBe("manual");
      expect(result.content).toBe(
        "This skill helps with date and time operations.",
      );
    });

    it("should derive id correctly from name with special characters", () => {
      const content = `---
name: "API/REST Helper!"
description: Help with REST APIs
triggers:
  - api
---

Content here.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.metadata.id).toBe("apirest-helper");
      expect(result.metadata.name).toBe("API/REST Helper!");
    });

    it("should derive id correctly from name with multiple spaces", () => {
      const content = `---
name: "My   Super   Skill"
description: A super skill
triggers:
  - super
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.metadata.id).toBe("my-super-skill");
    });

    it("should default source to manual when missing", () => {
      const content = `---
name: Test Skill
description: Test description
triggers:
  - test
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.metadata.source).toBe("manual");
    });

    it("should work correctly with all fields including explicit id and source", () => {
      const content = `---
id: custom-id
name: Complete Skill
description: A complete skill
source: extracted
createdAt: "2024-01-01T00:00:00Z"
sessionId: session-123
quality: 5
usageCount: 10
triggers:
  - complete
  - full
tags:
  - tag1
  - tag2
---

Full skill content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.metadata.id).toBe("custom-id");
      expect(result.metadata.name).toBe("Complete Skill");
      expect(result.metadata.description).toBe("A complete skill");
      expect(result.metadata.source).toBe("extracted");
      expect(result.metadata.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(result.metadata.sessionId).toBe("session-123");
      expect(result.metadata.quality).toBe(5);
      expect(result.metadata.usageCount).toBe(10);
      expect(result.metadata.triggers).toEqual(["complete", "full"]);
      expect(result.metadata.tags).toEqual(["tag1", "tag2"]);
      expect(result.content).toBe("Full skill content.");
    });

    it("should fail validation when name is missing", () => {
      const content = `---
description: Missing name
triggers:
  - test
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: name");
    });

    it("should fail validation when description is missing", () => {
      const content = `---
name: Test Skill
triggers:
  - test
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: description");
    });

    it("should fail validation when triggers is missing", () => {
      const content = `---
name: Test Skill
description: Test description
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: triggers");
    });

    it("should fail validation when triggers is empty array", () => {
      const content = `---
name: Test Skill
description: Test description
triggers: []
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: triggers");
    });
  });

  describe("edge cases", () => {
    it("should handle inline triggers array", () => {
      const content = `---
name: Inline Triggers
description: Test inline array
triggers: ["trigger1", "trigger2", "trigger3"]
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.metadata.triggers).toEqual([
        "trigger1",
        "trigger2",
        "trigger3",
      ]);
    });

    it("should handle unterminated inline array (missing closing bracket)", () => {
      const content = `---
name: Malformed Triggers
description: Test malformed inline array
triggers: ["trigger1", "trigger2"
---

Content.`;

      const result = parseSkillFile(content);

      // Missing ] should result in empty triggers array, failing validation
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing required field: triggers");
      expect(result.metadata.triggers).toEqual([]);
    });

    it("should handle quoted name and description", () => {
      const content = `---
name: "Quoted Name"
description: "Quoted Description"
triggers:
  - test
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.metadata.name).toBe("Quoted Name");
      expect(result.metadata.description).toBe("Quoted Description");
    });

    it("should handle single-quoted values", () => {
      const content = `---
name: 'Single Quoted'
description: 'Also single quoted'
triggers:
  - 'trigger'
---

Content.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(true);
      expect(result.metadata.name).toBe("Single Quoted");
      expect(result.metadata.description).toBe("Also single quoted");
      expect(result.metadata.triggers).toEqual(["trigger"]);
    });

    it("should fail when frontmatter is missing", () => {
      const content = `Just plain content without frontmatter.`;

      const result = parseSkillFile(content);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing YAML frontmatter");
    });
  });
});
