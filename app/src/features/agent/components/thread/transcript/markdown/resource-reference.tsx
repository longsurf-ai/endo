// Purpose: Display saved Resource references with the existing directive presentation.
import { useContext, type ComponentProps } from "react";
import { Link } from "react-router";
import { BoxIcon } from "lucide-react";
import { ResourceDestinationContext } from "@openchart/app/lib/resource/navigation";
import { DirectiveChip } from "@openchart/app/features/agent/components/thread/transcript/directive-text/directive-text";
import { DigInTextSpan } from "@openchart/app/features/agent/components/dig-in/dig-in-marker";

/** Resource spans carry parsed identity; all other spans retain Dig in behavior.
 * The label is a reply snapshot. Rendering never reads the Resource.
 * Missing routes remain noninteractive; routed references use normal Links.
 * @example <ResourceReferenceSpan data-resource-type="alert_rule" data-resource-id="alr_1" data-resource-label="Price alert" />
 */
export function ResourceReferenceSpan({
  "data-resource-type": resource,
  "data-resource-id": id,
  "data-resource-label": label,
  ...props
}: ComponentProps<typeof DigInTextSpan> & {
  "data-resource-type"?: string;
  "data-resource-id"?: string;
  "data-resource-label"?: string;
}) {
  const destination = useContext(ResourceDestinationContext);
  if (!resource || !id || !label) return <DigInTextSpan {...props} />;
  const to = destination(resource, id);
  return (
    <DirectiveChip
      directiveType={resource}
      directiveId={id}
      label={label}
      icon={BoxIcon}
      render={
        to ? (
          <Link to={to} data-dig-in-excluded />
        ) : (
          <span data-dig-in-excluded />
        )
      }
    />
  );
}
