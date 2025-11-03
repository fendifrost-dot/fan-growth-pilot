import { useMemo } from "react";

export type LeadSegment = 'all' | 'cold' | 'album-only' | 'merch-only' | 'both';

interface Lead {
  id: string;
  email: string;
  converted: boolean;
  album_purchased: boolean;
  conversion_value?: number;
  converted_at?: string;
  album_purchased_at?: string;
  purchase_source?: string;
  created_at: string;
  smart_links?: {
    title: string;
    slug: string;
  };
}

export const useLeadSegments = (leads: Lead[]) => {
  const segments = useMemo(() => {
    const cold = leads.filter(lead => !lead.converted && !lead.album_purchased);
    const albumOnly = leads.filter(lead => lead.album_purchased && !lead.converted);
    const merchOnly = leads.filter(lead => lead.converted && !lead.album_purchased);
    const both = leads.filter(lead => lead.converted && lead.album_purchased);

    return {
      all: leads,
      cold,
      albumOnly,
      merchOnly,
      both,
    };
  }, [leads]);

  const counts = {
    all: leads.length,
    cold: segments.cold.length,
    albumOnly: segments.albumOnly.length,
    merchOnly: segments.merchOnly.length,
    both: segments.both.length,
  };

  const exportSegment = (segment: LeadSegment) => {
    const segmentData = segments[segment === 'album-only' ? 'albumOnly' : segment === 'merch-only' ? 'merchOnly' : segment];
    
    if (segmentData.length === 0) {
      return null;
    }

    // Create CSV content with Facebook Custom Audience format
    const headers = ['Email', 'First Name', 'Last Name', 'Phone', 'Country', 'Zip'];
    const rows = segmentData.map(lead => [
      lead.email,
      '', // Facebook can match with email only
      '',
      '',
      '',
      ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    // Create download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `facebook-audience-${segment}-${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    return segmentData.length;
  };

  const filterLeads = (segment: LeadSegment): Lead[] => {
    return segments[segment === 'album-only' ? 'albumOnly' : segment === 'merch-only' ? 'merchOnly' : segment];
  };

  return {
    segments,
    counts,
    exportSegment,
    filterLeads,
  };
};
