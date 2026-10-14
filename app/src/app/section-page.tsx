// Purpose: Share the three-column page frame: the app sidebar, a 232px section rail and separately scrolling content.
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";

import { PageHeader } from "@openchart/app/app/page-header";
import { DropdownControl } from "@openchart/app/components/ui/settings/dropdown-control";
import { useSidebar } from "@openchart/app/components/ui/sidebar";
import { cn } from "@openchart/app/utils/cn";

/** One rail entry. Sections are UI routes owned by the page, never persisted configuration. */
export type PageSection = {
  readonly path: string;
  readonly title: string;
  readonly icon: LucideIcon;
  readonly end?: boolean;
  readonly badge?: ReactNode;
  /** Optional sibling control; never nest a menu trigger inside the navigation link. */
  readonly action?: ReactNode;
};

/** Related destinations separated from the primary section, e.g. saved rules below a Feed. */
export type PageSectionGroup = {
  readonly label: string;
  readonly sections: readonly PageSection[];
  readonly action?: ReactNode;
  readonly footer?: ReactNode;
};

/**
 * A top-level page with sections: the shared 60px header, a rail of section
 * links and independently scrolling content. Narrow screens replace the rail
 * with a dropdown in the header. The open section is the current
 * route; this component owns no state.
 *
 * @example
 * <SectionPage heading="Alerts" label="Alert rules" sections={alertsSections}>
 *   {content}
 * </SectionPage>
 */
export function SectionPage({
  heading,
  contentHeading,
  label,
  sections,
  groups = [],
  actions,
  status,
  footer,
  banner,
  children,
}: {
  /** The page name shown in the header and used to label the rail. */
  heading: string;
  /** Gives the right content column its own fixed header; the rail retains the page name. */
  contentHeading?: ReactNode;
  /** Accessible name of the whole page region, e.g. "Appearance settings". */
  label: string;
  sections: readonly PageSection[];
  groups?: readonly PageSectionGroup[];
  actions?: ReactNode;
  /** Rendered beside the heading, e.g. a save indicator. */
  status?: ReactNode;
  /** Content-pane controls outside its scroll area, e.g. an editor's Save/Cancel. */
  footer?: ReactNode;
  /** Persistent status spanning the content pane above its scroll area, e.g. an alert's monitoring banner. */
  banner?: ReactNode;
  children: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const hasNavigation = sections.length > 0 || groups.length > 0;
  const navigation = (
    <DropdownControl
      aria-label={`${heading} section`}
      value={location.pathname}
      options={[...sections, ...groups.flatMap((group) => group.sections)].map(
        (section) => ({ value: section.path, name: section.title }),
      )}
      onChange={(path) => {
        void navigate(String(path));
      }}
    />
  );
  const header = (
    <PageHeader actions={actions}>
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 flex-1 font-studio text-base font-medium">
            {contentHeading ?? heading}
          </h1>
          {status}
        </div>
        {hasNavigation && isMobile && !contentHeading ? (
          <div className="min-w-0 max-w-[14.5rem] flex-1">{navigation}</div>
        ) : null}
      </div>
    </PageHeader>
  );
  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      aria-label={label}
    >
      {!contentHeading ? header : null}
      <div className="flex min-h-0 flex-1">
        {hasNavigation && !isMobile ? (
          <nav
            aria-label={label}
            className={cn(
              "flex h-full w-[14.5rem] shrink-0 flex-col overflow-hidden px-1.5",
              contentHeading && "border-r",
            )}
          >
            {contentHeading ? (
              <div className="jan-chat-header shrink-0 px-2.5">
                <h2 className="font-studio text-base font-medium">{heading}</h2>
              </div>
            ) : null}
            <div className="flex min-h-0 w-full flex-1 flex-col gap-1 overflow-y-auto font-medium">
              <SectionLinks sections={sections} />
              {groups.map((group) => (
                <div key={group.label} className="mt-3 border-t pt-3">
                  <div className="mb-2 flex items-center justify-between gap-2 px-2">
                    <h2 className="text-xs font-medium text-muted-foreground">
                      {group.label}
                    </h2>
                    {group.action}
                  </div>
                  <div className="flex flex-col gap-1">
                    <SectionLinks sections={group.sections} />
                  </div>
                  {group.footer}
                </div>
              ))}
            </div>
          </nav>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col [container:section-content/inline-size]">
          {contentHeading ? header : null}
          {hasNavigation && isMobile && contentHeading ? (
            <div className="px-4 pb-3">{navigation}</div>
          ) : null}
          {banner}
          <div className="min-h-0 w-full flex-1 overflow-y-auto p-4 pt-0 [scrollbar-gutter:stable_both-edges]">
            {isMobile
              ? groups.map((group) => (
                  <div key={group.label}>{group.footer}</div>
                ))
              : null}
            <div className="flex w-full flex-col justify-between gap-4 gap-y-3">
              {children}
            </div>
          </div>
          {footer ? <div className="shrink-0 p-4">{footer}</div> : null}
        </div>
      </div>
    </section>
  );
}

function SectionLinks({ sections }: { sections: readonly PageSection[] }) {
  return sections.map((menu) => (
    <div key={menu.path} className="group/menu-item relative">
      <NavLink
        to={menu.path}
        end={menu.end}
        className={cn(
          "block w-full cursor-pointer gap-1.5 rounded-sm px-2 py-1 hover:bg-secondary dark:hover:bg-secondary/60 [&.active]:bg-secondary [&.active]:dark:bg-secondary/80",
          menu.action && "pr-9",
        )}
      >
        <div className="flex items-center gap-2">
          <menu.icon
            size={18}
            aria-hidden="true"
            className="shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate">{menu.title}</span>
          {menu.badge}
        </div>
      </NavLink>
      {menu.action}
    </div>
  ));
}
