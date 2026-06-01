import { owletLogoAssetPath } from "../brandAssets";

export function OwletLogo() {
  return (
    <div className="flex items-center gap-6" aria-label="Owlet">
      <img
        alt=""
        aria-hidden="true"
        className="h-44 w-44"
        src={owletLogoAssetPath}
      />
      <span className="font-heading text-[5rem] font-semibold leading-none tracking-normal text-[#1f2933]">
        Owlet
      </span>
    </div>
  );
}
