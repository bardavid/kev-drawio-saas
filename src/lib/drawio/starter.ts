/**
 * Small starter architecture so the first open is never a blank page.
 * Uncompressed mxfile — draw.io accepts this directly via the load action.
 */
export const STARTER_XML = `<mxfile host="embed.diagrams.net" agent="Kev Diagram" version="24.7.17" type="device">
  <diagram id="architecture" name="Architecture">
    <mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="2" value="Client" style="rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#ffe6cc;strokeColor=#d79b00;" vertex="1" parent="1">
          <mxGeometry x="80" y="180" width="140" height="64" as="geometry"/>
        </mxCell>
        <mxCell id="3" value="API" style="rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">
          <mxGeometry x="340" y="180" width="150" height="64" as="geometry"/>
        </mxCell>
        <mxCell id="4" value="Postgres" style="shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="610" y="168" width="140" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="5" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=classic;endFill=1;strokeColor=#64748b;fontColor=#334155;" edge="1" parent="1" source="2" target="3">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="6" value="SQL" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=classic;endFill=1;strokeColor=#64748b;fontColor=#334155;" edge="1" parent="1" source="3" target="4">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
