'use client';
import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, colorSchemeDark, type ColDef } from 'ag-grid-community';
import { useRouter } from 'next/navigation';
import { Badge } from './ui';
import { money } from '@/lib/domain';
ModuleRegistry.registerModules([AllCommunityModule]);
const theme = themeQuartz.withPart(colorSchemeDark).withParams({ accentColor: '#c4f27a', backgroundColor: '#141814', foregroundColor: '#e8e4ce', borderColor: '#363d30', headerBackgroundColor: '#1d241b', headerTextColor: '#aeb89d', fontFamily: 'var(--font-mono, monospace)', fontSize: 12, headerFontSize: 10, rowHeight: 48, headerHeight: 42, wrapperBorderRadius: 3, cellHorizontalPadding: 16, rowBorder: true, oddRowBackgroundColor: '#171c16', selectedRowBackgroundColor: '#2a3823', rowHoverColor: '#222b1e' });
export type GridRow = Record<string, unknown> & { id: string; href?: string };
export function RecordsGrid({ rows, columns, search = '', onRowSelect }: { rows: GridRow[]; columns: { field: string; headerName: string; width?: number; money?: boolean; status?: boolean; flex?: number }[]; search?: string; onRowSelect?: (row: GridRow) => void }) {
  const router = useRouter();
  const defs = useMemo<ColDef<GridRow>[]>(() => columns.map(c => ({ field: c.field, headerName: c.headerName, minWidth: c.width ?? 140, flex: c.flex ?? 1, filter: true, sortable: true, resizable: true, ...(c.status ? { cellRenderer: (p: { value: string }) => <Badge>{p.value}</Badge> } : {}), ...(c.money ? { valueFormatter: (p: { value: number | undefined }) => typeof p.value === 'number' ? money(p.value) : '' } : {}) })), [columns]);
  const select = (row: GridRow | undefined) => { if (!row) return; if (onRowSelect) onRowSelect(row); else if (row.href) router.push(row.href); };
  return <div className="records-grid"><AgGridReact<GridRow> theme={theme} rowData={rows} columnDefs={defs} quickFilterText={search} domLayout="autoHeight" getRowId={p => p.data.id} onRowClicked={e => select(e.data)} onCellKeyDown={e => { if ((e.event as KeyboardEvent).key === 'Enter') select(e.data); }} pagination={rows.length > 12} paginationPageSize={12} paginationPageSizeSelector={false} overlayNoRowsTemplate="<span>No records yet. Use the create action to get started.</span>" /></div>;
}
