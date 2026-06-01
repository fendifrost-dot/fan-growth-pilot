import React from "react";
import { Link, Outlet } from "react-router-dom";

const AdminGuard: React.FC = () => {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/admin" className="font-medium tracking-tight">Fendi Frost · Admin</Link>
            <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              <Link to="/admin" className="hover:underline font-medium">Hub</Link>
              <Link to="/admin/send" className="hover:underline font-medium text-primary">Send</Link>
              <span className="text-muted-foreground text-xs uppercase tracking-wide">Pitching</span>
              <Link to="/admin/catalogue" className="hover:underline">Catalogue</Link>
              <Link to="/admin/categories" className="hover:underline">Categories</Link>
              <Link to="/admin/pitch-composer" className="hover:underline">Pitch Composer</Link>
              <Link to="/admin/playlists" className="hover:underline">Find playlists</Link>
              <Link to="/admin/outreach" className="hover:underline">Curator drafts</Link>
              <Link to="/admin/campaigns" className="hover:underline">Email campaigns</Link>
              <Link to="/admin/radio" className="hover:underline">Radio</Link>
              <Link to="/admin/pitch-log" className="hover:underline">Pitch log</Link>
              <Link to="/admin/ig-queue" className="hover:underline">IG queue</Link>
              <Link to="/admin/contacts" className="hover:underline">Contacts</Link>
            </nav>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
};

export default AdminGuard;
