"use client"

import { useMemo, useState } from "react"
import { CaretLeft, CaretRight } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const TABLE_PAGINATION_PAGE_SIZE = 25

export function useTablePagination<T>(
  rows: readonly T[],
  pageSize: number = TABLE_PAGINATION_PAGE_SIZE,
) {
  const [page, setPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [rows, safePage, pageSize],
  )
  return {
    page: safePage,
    setPage,
    pageCount,
    pageRows,
    totalCount: rows.length,
    pageSize,
  }
}

type TablePaginationProps = {
  page: number
  pageCount: number
  totalCount: number
  onPageChange: (page: number) => void
  pageSize?: number
  emptyLabel?: string
  className?: string
}

export function TablePagination({
  page,
  pageCount,
  totalCount,
  onPageChange,
  pageSize = TABLE_PAGINATION_PAGE_SIZE,
  emptyLabel = "No matching records",
  className,
}: TablePaginationProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-t border-border/70 px-4 py-2.5",
        className,
      )}
    >
      <p className="text-[10px] text-muted-foreground">
        {totalCount === 0
          ? emptyLabel
          : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalCount)} of ${totalCount}`}
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <CaretLeft className="h-3.5 w-3.5" />
          <span className="sr-only">Previous page</span>
        </Button>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map(
          (pageNumber) => (
            <Button
              key={pageNumber}
              variant={page === pageNumber ? "default" : "ghost"}
              size="icon"
              className="h-7 w-7 text-xs"
              onClick={() => onPageChange(pageNumber)}
            >
              {pageNumber}
            </Button>
          ),
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        >
          <CaretRight className="h-3.5 w-3.5" />
          <span className="sr-only">Next page</span>
        </Button>
      </div>
    </div>
  )
}
