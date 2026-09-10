import { describe, expect, it } from "vitest";

import { t } from "./index";

describe("connection modal catalog aliases", () => {
  it("translates picker chrome and driver-unavailable copy for Japanese", () => {
    expect(t("connection.modal.title.step1", undefined, "ja-JP")).toBe(
      "データソースの種類を選択",
    );
    expect(t("connection.modal.description.step1", undefined, "ja-JP")).toBe(
      "対応しているデータソースから接続タイプを選択します。",
    );
    expect(
      t("connection.modal.typeWarning.unavailable", { name: "InterSystems Caché" }, "ja-JP"),
    ).toBe("InterSystems Caché ドライバーは利用できません");
    expect(t("connection.modal.driver.installAction", undefined, "ja-JP")).toBe(
      "ドライバー管理を開く",
    );
    expect(t("connection.modal.title.step1", undefined, "ja-JP")).not.toContain("选择");
    expect(t("connection.modal.driver.installAction", undefined, "ja-JP")).not.toContain("驱动");
  });
});
