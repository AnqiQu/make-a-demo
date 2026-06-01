import { owletLogoAssetPath } from "../../../src/apps/web/brandAssets";

describe("owletLogoAssetPath", () => {
  it("points the brand component at the uploaded Owlet logo destination", () => {
    expect(owletLogoAssetPath).toBe("/assets/owlet-logo.png");
  });
});
