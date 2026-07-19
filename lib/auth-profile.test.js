import { describe, expect, it } from "vitest";
import { buildAuthProfilePatch, selectedProviderId } from "./auth-profile.js";

describe("auth profile bootstrap", () => {
  it("keeps exactly the provider used for the current sign-in", () => {
    expect(selectedProviderId({
      providerData: [{ providerId: "google.com" }, { providerId: "apple.com" }],
    }, { telegramId: "123" }, "google.com")).toBe("google.com");
    expect(selectedProviderId({}, { telegramId: "123" }, "custom")).toBe("telegram");
  });

  it("seeds a new federated profile", () => {
    expect(buildAuthProfilePatch({
      authUser: {
        email: " User@Example.com ",
        emailVerified: true,
        displayName: "Иван Петров",
        photoURL: "https://example.com/avatar.png",
        providerData: [{ providerId: "google.com" }],
      },
      existing: {},
    })).toMatchObject({
      email: "user@example.com",
      emailVerified: true,
      firstName: "Иван",
      lastName: "Петров",
      role: "reader",
      authProvider: "google.com",
    });
  });

  it("does not overwrite a confirmed HoldingMan name", () => {
    const patch = buildAuthProfilePatch({
      authUser: {
        email: "user@example.com",
        displayName: "Google Name",
        providerData: [{ providerId: "google.com" }],
      },
      existing: {
        firstName: "Тэко",
        lastName: "Исаев",
        profileCompleted: true,
        role: "reader",
      },
    });
    expect(patch).not.toHaveProperty("firstName");
    expect(patch).not.toHaveProperty("lastName");
    expect(patch).not.toHaveProperty("role");
  });
});
