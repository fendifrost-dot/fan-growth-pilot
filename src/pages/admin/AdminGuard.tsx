import React from "react";
import { Link, Outlet } from "react-router-dom";

const AdminGuard: React.FC = () => {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link to="/admin/campaigns" className="font-medium tracking-tight">Fendi Frost · Admin</Link>
            <nav className="flex items-center gap-6 text-sm">
              <Link to="/admin/campaigns" className="hover:underline">Campaigns</Link>
              <Link to="/admin/contacts" className="hover:underline">Contacts</Link>
              <Link to="/admin/playlists" className="hover:underline">Playlists</Link>
              <Link to="/admin/outreach" className="hover:underline">Outreach</Link>
              <Link to="/admin/ig-queue" className="hover:underline">IG queue</Link>
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
