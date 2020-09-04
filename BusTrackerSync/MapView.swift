import MapKit
import SwiftUI

struct MapView: UIViewRepresentable {
  var busRoute: BusRoute
  
  func makeUIView(context: Context) -> MKMapView {
    let mapView = MKMapView()
    mapView.delegate = context.coordinator
    mapView.showsUserLocation = true
    return mapView
  }

  func updateUIView(_ view: MKMapView, context: Context) {
    view.removeOverlays(view.overlays)
    view.removeAnnotations(view.annotations)
    
    let polylines = busRoute.polyline.compactMap { $0.mkPolyline }
    view.addOverlays(polylines)
    
    let annotations = busRoute.busStopInfos.flatMap({$0}).map { (stopInfo) -> MKAnnotation in
      let annotation = MKPointAnnotation()
      annotation.coordinate = stopInfo.busStop!.coordinate
      return annotation
    }
    view.addAnnotations(annotations)
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(self)
  }

  class Coordinator: NSObject, MKMapViewDelegate {
    var parent: MapView

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
      let renderer = MKPolylineRenderer(polyline: overlay as! MKPolyline)
      renderer.strokeColor = UIColor.systemPurple
      renderer.lineCap = .round
      renderer.lineWidth = 3
      return renderer
    }

    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
      let identifier = "placemark"

      var annotationView = mapView.dequeueReusableAnnotationView(withIdentifier: identifier)

      if annotationView == nil {
          annotationView = MKPinAnnotationView(annotation: annotation, reuseIdentifier: identifier)
          annotationView?.canShowCallout = true
      } else {
          annotationView?.annotation = annotation
      }
      return annotationView
    }

    init(_ parent: MapView) {
      self.parent = parent
    }
  }
}
