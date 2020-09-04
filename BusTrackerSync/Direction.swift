import CoreLocation
import Polyline

struct RouteSequence: Decodable {
  enum CodingKeys: String, CodingKey {
    case encodedPolyline = "GEOMETRIES"
  }
  
  let encodedPolyline: String
}

struct RoutePayload: Decodable {
  enum CodingKeys: String, CodingKey {
    case busDirectionOne = "BUS_DIRECTION_ONE"
    case busDirectionTwo = "BUS_DIRECTION_TWO"
  }
  
  let busDirectionOne: [RouteSequence]?
  let busDirectionTwo: [RouteSequence]?
}

extension RoutePayload {
  var coordinates: [CLLocationCoordinate2D] {
    let sequences = busDirectionOne ?? busDirectionTwo ?? []
    let coordinates = sequences.map { sequence -> [CLLocationCoordinate2D] in
      return Polyline(encodedPolyline: sequence.encodedPolyline).coordinates ?? []
    }.flatMap { $0 }
    return coordinates
  }
}
