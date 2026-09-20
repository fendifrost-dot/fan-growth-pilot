import React, { useState } from "react";
import { NavLink, Outlet, Link, useLocation } from "react-router-dom";
import { Menu, Music, Settings, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { HUB_NAV, HUB_NAV_ITEMS } from "./hubNav";

const NavItems: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => (
  <nav className="flex flex-col gap-6">
    {HUB_NAV.map((group) => (
      <div key={group.heading}>
        <p className="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {group.heading}
        </p>
        <div className="flex flex-col gap-1">
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    "group flex items-start gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-foreground/80 hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <Icon className="w-5 h-5 mt-0.5 shrink-0" />
                <span className="flex flex-col">
                  <span>{item.label}</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    {item.description}
                  </span>
                </span>
              </NavLink>
            );
          })}
        </div>
      </div>
    ))}
    <div className="pt-2 border-t border-border">
      <Link
        to="/admin"
        onClick={onNavigate}
        className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
      >
        <Settings className="w-5 h-5 shrink-0" />
        <span>Operator tools</span>
      </Link>
    </div>
  </nav>
);

const Brand: React.FC = () => (
  <Link to="/hub" className="flex items-center gap-3">
    <div className="w-9 h-9 rounded-lg bg-gradient-gold flex items-center justify-center">
      <Music className="w-5 h-5 text-primary-foreground" />
    </div>
    <span className="text-lg font-bold bg-gradient-gold bg-clip-text text-transparent">
      Artist Growth Hub
    </span>
  </Link>
);

const ArtistLayout: React.FC = () => {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  const current =
    HUB_NAV_ITEMS.find((i) =>
      i.end ? location.pathname === i.to : location.pathname.startsWith(i.to),
    ) ?? HUB_NAV_ITEMS[0];

  return (
    <div className="min-h-screen bg-gradient-dark">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-72 flex-col border-r border-border bg-card/60 backdrop-blur-sm">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <NavItems />
        </div>
      </aside>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-80 p-0 bg-card">
          <div className="h-16 flex items-center justify-between px-6 border-b border-border">
            <Brand />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </Button>
          </div>
          <div className="px-4 py-6 overflow-y-auto h-[calc(100vh-4rem)]">
            <NavItems onNavigate={() => setMobileOpen(false)} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="lg:pl-72">
        {/* Top bar */}
        <header className="sticky top-0 z-40 h-16 flex items-center gap-3 px-4 sm:px-6 border-b border-border bg-card/60 backdrop-blur-sm">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="w-6 h-6" />
          </Button>
          <div className="lg:hidden">
            <Brand />
          </div>
          <h1 className="hidden lg:block text-xl font-semibold">{current.label}</h1>
        </header>

        <main className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-6xl mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default ArtistLayout;
