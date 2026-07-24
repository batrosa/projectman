import { describe, expect, it } from "vitest";
import { buildAuthProfilePatch, linkedProviderIds, selectedProviderId } from "./auth-profile.js";

describe("auth profile bootstrap", () => {
  it("keeps exactly the provider used for the current sign-in", () => {
    expect(selectedProviderId({
      providerData: [{ providerId: "google.com" }, { providerId: "apple.com" }],
    }, { telegramId: "123" }, "google.com")).toBe("google.com");
    expect(selectedProviderId({}, { telegramId: "123" }, "custom")).toBe("telegram");
    expect(selectedProviderId({
      providerData: [{ providerId: "password" }],
    }, {}, "password")).toBe("password");
  });

  it("repairs a stale Telegram primary provider from Firebase providerData", () => {
    const authUser = {
      email: "oleg@example.com",
      emailVerified: true,
      providerData: [{ providerId: "password" }],
    };
    const existing = {
      authProvider: "telegram",
      telegramId: "777",
      telegramChatId: "777",
    };

    expect(selectedProviderId(authUser, existing, "password")).toBe("password");
    expect(linkedProviderIds(authUser, existing, "password")).toEqual(["password", "telegram"]);
    expect(buildAuthProfilePatch({ authUser, existing, signInProvider: "password" })).toMatchObject({
      authProvider: "password",
      authProviders: ["password", "telegram"],
    });
  });

  it("repairs a stale Google label when Firebase only has password", () => {
    const authUser = {
      providerData: [{ providerId: "password" }],
      emailVerified: true,
    };
    const existing = { authProvider: "google.com" };
    expect(selectedProviderId(authUser, existing, "password")).toBe("password");
    expect(linkedProviderIds(authUser, existing, "password")).toEqual(["password"]);
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

  it("does not overwrite a confirmed ProjectSfera name", () => {
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

  it("marks a legacy profile with an existing full name as complete", () => {
    expect(buildAuthProfilePatch({
      authUser: {
        email: "legacy@example.com",
        providerData: [{ providerId: "password" }],
      },
      existing: {
        firstName: "Тэко",
        lastName: "Исаев",
        role: "reader",
      },
      signInProvider: "password",
    })).toMatchObject({
      profileCompleted: true,
    });
  });

  it("keeps the name gate for incomplete legacy profiles", () => {
    const patch = buildAuthProfilePatch({
      authUser: {
        email: "legacy@example.com",
        providerData: [{ providerId: "password" }],
      },
      existing: {
        firstName: "Тэко",
        lastName: "",
        role: "reader",
      },
      signInProvider: "password",
    });
    expect(patch).not.toHaveProperty("profileCompleted");
  });
});
