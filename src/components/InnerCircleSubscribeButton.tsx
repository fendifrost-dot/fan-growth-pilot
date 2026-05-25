import { buildInnerCircleRedirectUrl } from "@/lib/innerCircle";
import { cn } from "@/lib/utils";

/** Polar bear — never use brown bear 🐻 alone for Inner Circle. */
const CTA_LABEL = "🐻‍❄️ Join the Inner Circle";

type Props = {
  slug: string;
  email?: string | null;
  className?: string;
  onClick?: () => void;
};

/**
 * Smart-link CTA → telegram-signup-redirect → t.me deep link with attribution token.
 */
export function InnerCircleSubscribeButton({ slug, email, className, onClick }: Props) {
  const href = buildInnerCircleRedirectUrl(slug, {
    email,
    searchParams: typeof window !== "undefined" ? new URLSearchParams(window.location.search) : undefined,
  });

  return (
    <a
      href={href}
      data-testid="inner-circle-cta"
      onClick={onClick}
      className={cn(
        "flex w-full h-[50px] items-center justify-center rounded-md",
        "border border-white/35 bg-transparent text-white font-bold tracking-wide text-sm sm:text-base",
        "transition-all duration-200 shadow-lg",
        "hover:bg-white/10 hover:scale-[1.02] active:scale-[0.98]",
        className,
      )}
    >
      {CTA_LABEL}
    </a>
  );
}
